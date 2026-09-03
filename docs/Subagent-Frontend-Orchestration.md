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
   **Slice a large plan** (see "Slicing a large plan" below) rather than handing one agent the
   whole thing.
5. **Builder self-checks the diff against every plan item** before reporting done.
6. **A fresh Sol diff review** — mechanical correctness and regressions only, same as the standard
   pipeline.
7. **Builder applies Sol's fixes.**
8. **Luna runs the browser smoke test and the first visual pass** (`codex exec`,
   `-m gpt-5.6-luna -c model_reasoning_effort=xhigh`, browser/Chrome-use enabled). Owner decision,
   2026-09-02: for this lane Luna-with-Chrome replaces Agy as the browser tester, because Codex
   drives Chrome directly and reaches the human-authenticated sessions the owner keeps signed in on
   **both** local dev and `quincy.flamingfire.my`. Luna's job here is *reporting*, not taste: walk
   the plan's real-browser acceptance criteria at the three fixed viewports, capture the evidence
   images, and report what it observes — console errors, failed requests, broken layout, missing
   focus rings, anything that does not match the plan's stated intent. Luna does **not** judge
   whether a design is good; it has no more taste than Sol. Prod stays passive-only; mutations go
   to local dev. Luna never runs Google OAuth itself — if a session is missing it stops and says so.

   **How Luna actually reaches Chrome** (established 2026-09-03, TB8-05 — the decision above named
   the router but not the mechanism, and there wasn't one written down). Attach
   `chrome-devtools-mcp` to the same human-authenticated Chrome Agy uses, over CDP on port 9333,
   passed per-run with `-c` so nothing in the user's codex config changes:

   ```
   codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-luna \
     -c model_reasoning_effort=xhigh \
     -c 'mcp_servers.chrome_devtools={command="npx",args=["-y","chrome-devtools-mcp@latest",\
         "--browserUrl=http://127.0.0.1:9333"],startup_timeout_sec=180}' \
     --output-last-message <report> < <prompt>
   ```

   The unsandboxed flag is **required, not a convenience**: under a sandbox, `list_pages` works but
   `evaluate_script` returns *"requires approval, which is unavailable"*, and every measurement in
   a browser pass is an `evaluate_script`. `-c approval_policy="never"` does not lift it. This mode
   is owner-authorized and governed by `Subagent-Orchestration.md` §2.11 — its restriction block
   goes in **every** such prompt, and the orchestrating session snapshots the repo (`git status`,
   `git rev-parse HEAD`, a `shasum` manifest) before the spawn and diffs it after, because
   read-only-on-the-repo is the one restriction the prompt cannot enforce on itself.
9. **Opus visual/taste review — the last gate, and this session's own.** Open the rendering in the
   Browser pane and compare it against the plan's *intent*, not just the diff and not just Luna's
   report. Luna's findings are input, not a verdict: verify them, and look for what it could not
   see. This step exists specifically to catch what a mechanical pipeline misses, and it does not
   delegate.
10. **The §5 gate** (this session — `Subagent-Orchestration.md` §5 for the general content).
11. **Deploy and commit**, per standing order.

## Slicing a large plan

A plan past roughly 1,500 lines should not go to a single builder: the agent spends its whole
allowance reading before it writes anything, and a mid-run rate-limit death then costs the entire
run. TB8-04's first builder attempt died exactly this way at 3,623 lines, having written zero code.

Slice by the plan's own section boundaries, bottom-up so nothing is ever half-wired — primitives,
then new components, then screens, then the legacy-CSS retirement ledger, then tests and docs. Give
each slice agent the *exact line ranges* of the sections it must read in full, plus the shared
constraint sections (scope, cascade rule, behavioural invariants) every slice needs. Each slice ends
green on typecheck and build; only the final slice must satisfy the full gate. A slice that dies is
then cheap to re-run.

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
