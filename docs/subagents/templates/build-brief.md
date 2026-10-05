<!-- Build brief for fast-worker (Agent tool) or a Codex workspace-write run. Replace every <…>;
delete this comment. -->
Build ticket #<n> in the worktree `<absolute worktree path>` (branch `<branch>`). Work only there.
Do not commit or push unless this brief says so. Never read `.dev.vars`, `.env*` or `.mcp.json`.

**Resume notes.** Keep running notes (file:line findings, decisions) in
`<scratch>/notes-<task>.md`; on resume read it first and do not re-explore what it records.

**The settled plan** is `<docs/plans/<n>.md or the issue comment URL>`. Follow it; anything it does
not settle that changes behaviour, a schema or an API, stop and report rather than guess.

Owned files: <list or globs>. A change needed elsewhere goes in the report, not the diff.

Shell is macOS zsh: `sed -i ''`, quote globs or use `rg -g`, `perl -e 'alarm N; exec @ARGV' cmd`
instead of `timeout`. Save long test output to a file in `<scratch>` and grep it; don't re-run to
see more.

Prove it before reporting:
- red test first, then green: `<npx vitest run --config … path>`
- `npx tsc -p <pkg>/tsconfig.json` for every package touched
- the guards beside what you touched (`*.guard.test.ts`)
- UI: the reuse-ledger line for every new element (AGENTS.md "Reuse ReUI before building UI")

Report (≤300 words): files changed, the commands run with exit codes, anything left undone and why.
