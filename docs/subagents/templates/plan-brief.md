<!-- Plan brief for Codex (scripts/agents/codex-plan.sh) or a deep-reasoner Agent. Replace every
<…>; delete this comment. A Codex read-only run is offline: paste the issue and parent spec below
(fetch them with `gh issue view <n>` before dispatch). -->
You are planning ONE ticket for the Quincy Portal repo. Read-only: do not edit files. Code is in
`portal/`. Never read `.dev.vars`, `.env*` or `.mcp.json`.

**Resume notes.** Keep running notes (file:line findings, decisions) in
`<scratch>/notes-<task>.md`; on resume read it first and do not re-explore what it records.

Read: the ticket and parent spec below, `AGENTS.md`, the `CONTEXT.md` of each package you touch,
the relevant `docs/adr/*`, the relevant `docs/lessons.md` sections, and the code you would change.
For a UI ticket that adopts a ReUI block, also `docs/reui-block-adoption.md` and
`docs/reui-reuse.md`.

Produce an implementation plan of AT MOST 70 lines, no preamble:
1. Files and modules to change and how (name the concrete functions, tables and routes).
2. Schema/migration changes (exact columns, types, defaults) and API contract changes.
3. Test plan: the seams, which existing test files are prior art, the key cases (red tests first).
4. Risks and traps specific to this codebase (cite lessons.md / ADR / guard tests), and each
   decision the ticket leaves open with your recommendation.
5. For UI: the reuse ledger, one line per element (registry name or file path, or the searches run
   and why each candidate fails).

Base: <origin/main at sha>. Other open work touching the same files: <PRs, or "none">.

## Ticket #<n>
<paste `gh issue view <n>` body>

## Parent spec #<m>
<paste>

<!-- The settled plan goes to the issue as a comment or to docs/plans/<issue>.md — never only a
scratchpad (Subagent-Orchestration.md §4). -->
