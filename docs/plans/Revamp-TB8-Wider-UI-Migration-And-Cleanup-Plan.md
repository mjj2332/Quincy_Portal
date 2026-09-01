# TB8 — Wider UI Migration and Cleanup: Kickoff

**Status:** drafted, not yet built. See [roadmap/TB8-Wider-UI-Migration-And-Cleanup.md](revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md) for the approved scope (selection order, candidate releases, rules, completion criteria) — this doc adds the pipeline this session is using and the scope extension agreed 2026-09-01. Move to `implemented/` once built, verified, and deployed, per the standing convention.

## Why this deviates from the standing pipeline

Codex-family builds (Luna) on prior surfaces produced UI with poor design skill and taste. Sol
reviews and Luna builds are the same base model (`gpt-5.6`) under different personas — thinner
separation than a genuinely different model's eyes, and neither carries design judgment. For TB8
specifically, this session substitutes a Claude-only design lane for the plan+build stages, while
keeping Sol for mechanical diff-correctness review. This is a scoped, deliberate exception per
[Subagent-Orchestration.md](../Subagent-Orchestration.md) §1's own footnote that Sonnet-tool builds
are valid at this session's discretion — recorded here rather than silently deviating.

## Pipeline for TB8 (replaces the standard routing table for this tracer bullet only)

1. **Opus subagent drafts the visual plan**, `/frontend-design` skill loaded, at
   implementation-detail resolution — exact Tailwind classes/tokens, spacing scale, component
   states (default/hover/focus/disabled/error), not directional prose ("make it feel more
   premium"). Ambiguity left in the plan is what caused the prior taste failures; the plan must
   close it, not defer it to the builder's judgment. The plan must derive every token/class
   from the repo's own design system — `prototype/_ds/quincy-productions-design-system-*/`
   (readme + `tokens/*.css` — authoritative source: ink/paper duotone, greige ramp, Mazius
   Review/Apfel Grotezk/Messapia/Athelas type roles, hairline rules, square corners, no-shadow
   elevation) as already ported into `portal/apps/web/src/styles/tokens`. New values are not
   invented; the plan cites the existing token.
2. **Sol reviews the plan** for scope/correctness (≤2 rounds, per standing §2.1) — not for
   aesthetics, which Sol cannot judge any better than Luna can.
3. **Opus plan-approves** (or self-edits past the ≤2-round cap, per standing §2.1).
4. **Sonnet subagent (`Agent` tool, `model: sonnet`) builds** — not Luna. Rationale: a genuinely
   different model family carries real design judgment and can catch/fix plan ambiguity in place
   instead of defaulting toward generic-shadcn output.
5. Builder self-checks the diff against every plan item.
6. **Fresh Sol diff review** — mechanical correctness/regressions, same as standard pipeline.
7. Builder applies fixes.
8. **Opus visual/taste review** — this is the step that replaces Luna's build-taste gap. Opus
   compares the deployed/local-dev rendering against the plan's intent, not just the diff.
9. **§5 gate** (this session, per standing doc) — typecheck/build/tests, security/correctness
   diff read, and now also a visual pass in the Browser pane against the plan before sign-off.
10. Deploy and commit, per standing order.

Agy retains its normal QA/testing role (§2.8–§2.10) unchanged — this substitution only touches the
plan-and-build stages, not testing.

## Scope extension: UI rescue and revamp, not just the roadmap candidate list

In addition to the roadmap's [candidate releases](revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md#candidate-releases),
Opus's visual plan(s) for TB8 should cover **every UI surface each planned task touches**, treated
as a UI rescue-and-revamp pass on that surface — not limited to the specific
control/pattern the roadmap candidate names. If a candidate release is "Dashboard shell/filters/
cards/navigation," Opus's plan for that release should assess and (where warranted) redesign the
full visual surface of the dashboard shell as touched, not just the specific filter/card control
that motivated the candidate's inclusion.

This still runs through the roadmap's existing rules unchanged: matched evidence at relevant fixed
viewports/states, preserve approved evolution/accessibility/security behavior, owner approval for
intentional evolution/deferral, one styling/data owner, no whole-app rewrite or stock shadcn
appearance, no raw framework palette contract, full product/accessibility/tests/QA. The extension
widens *what counts as in scope for a visual pass* on each candidate's surface — it does not waive
any roadmap rule or the selection-order process.

Each candidate release remains its own reviewed plan/release per the roadmap; the widened scope
applies within each release's plan, not as one combined mega-plan across all candidates.

## Next step

Rank the roadmap's candidate releases per the roadmap's selection-order criteria (operational
pain, unwanted-drift severity, reuse value, accessibility risk, ability to retire a legacy owner)
and pick the first surface to run through the pipeline above.

## Ranking (2026-09-01)

1. **Dashboard shell/filters/cards/navigation** — highest reuse value, TB0-VIS-01 flags a real
   390px overflow/clipping bug, roadmap itself favors shell/ordinary-controls first.
2. Ordinary menus/dialogs/popovers/sheets
3. Project Workspace rail/collection controls/states
4. Remaining project/admin forms
5. Notification bell/preferences/Admin delivery UI
6. Board filters/card controls
7. Collaboration/checklist/comments (fresh from TB6, low priority)
8. Notice board (fresh from TB7, too new)
9. Lightbox controls (only if evidence warrants)
10. Dead selectors / final base/Preflight decision (cleanup, near the end)
11. Legacy fetch/emission paths (roadmap-gated: last, only after replacements prove ownership)

## Decision: Tailwind adoption scope for TB8 (2026-09-01)

TB1 (deployed 2026-08-25) scoped Tailwind v4/shadcn/Base UI to exactly one bounded consumer — the
`ProjectFields` Client section — per D-16/A8. `app.css`/`index.css` for the rest of `apps/web` does
not otherwise consume Tailwind; the Dashboard shell currently styles entirely through the ported
CSS-custom-property token system.

**Owner decision: TB8 extends Tailwind to the Dashboard shell surface** (candidate release #1),
using the existing Tailwind v4 + shadcn (`base-sera` style, `cssVariables: true`, Lucide icons,
Preflight disabled, no dark mode) foundation already wired in `portal/apps/web/components.json`
and `src/styles/index.css` — not a new/parallel Tailwind setup. This widens what TB1 called "one
bounded consumer" to a second, TB8-owned surface; it is not a whole-app rewrite (roadmap rule
still holds) and every token must still trace to the ported design-system values, now expressed as
Tailwind theme/utility classes instead of raw CSS custom properties directly. Matched evidence
stays at TB1's viewports (`1440×900`, `1024×768`, `390×844`).

The first Dashboard shell visual plan (`TB8-01-Dashboard-Shell-Visual-Plan.md`, drafted before this
decision) assumed `app.css`/CSS-custom-properties stays the sole styling owner — it is being
revised to the Tailwind/shadcn foundation per this decision before it goes to Sol for review.
