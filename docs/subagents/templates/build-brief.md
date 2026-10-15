<!-- Build brief for ui-builder (UI) or fast-worker (everything else), both via the Agent tool, or a
Codex workspace-write run. Replace every <…>; delete this comment. -->
Build ticket #<n> in the worktree `<absolute worktree path>` (branch `<branch>`). Work only there.
Do not commit or push unless this brief says so. Never read `.dev.vars`, `.env*` or `.mcp.json`.

**Resume notes.** Keep running notes (file:line findings, decisions) in
`<scratch>/notes-<task>.md`; on resume read it first and do not re-explore what it records.

**The settled plan** is `<docs/plans/<n>.md or the issue comment URL>`. Follow it; anything it does
not settle that changes behaviour, a schema or an API, stop and report rather than guess.

**UI only — the prototype:** `design/prototypes/<name>/project/<files>`, frames <ids>. Read each
frame's source before building; the plan's frame-to-component map says what renders it. Where a
frame conflicts with a ReUI component or a guard, stop and report. Omit this paragraph when the
work has no prototype.

Owned files: <list or globs>. A change needed elsewhere goes in the report, not the diff.

Shell is macOS zsh: `sed -i ''`, quote globs or use `rg -g`, `perl -e 'alarm N; exec @ARGV' cmd`
instead of `timeout`. Save long test output to a file in `<scratch>` and grep it; don't re-run to
see more.

Prove it before reporting:
- red test first, then green: `<npx vitest run --config … path>`
- `npx tsc -p <pkg>/tsconfig.json` for every package touched
- the guards beside what you touched (`*.guard.test.ts`)
- UI: `npm run verify` from `portal/`, and the states the session should check in the browser and
  the iOS Simulator

Report (≤300 words): files changed, the commands run with exit codes, anything left undone and why.
