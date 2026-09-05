# Codex CLI mechanics (Sol / Terra / Luna / Astra)

Loaded on demand from `Subagent-Orchestration.md` §3. Updated 2026-09-05.

`codex exec` runs the real Codex CLI as an OS subprocess via `Bash` — OpenAI's model, its own
sandbox, output read back from a file. It is not the `Agent` tool.

```bash
codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=high "..."
```


**GPT-6-Astra** is available as the `gpt-6-astra` Codex model. Pass `-m gpt-6-astra` explicitly
when Astra is required; the account default is not a reliable model selector. Codex models have
native **Chrome-use** and **Computer-use** skills/plugins for browser and desktop control.

Full spawn shape, with the spec in a scratchpad file and the report captured separately.
**Pipe the prompt via stdin — do not embed it as a `"$(cat ...)"` positional argument** (see
the stdin-hang failure mode below for why):

```bash
SCRATCH=".../scratchpad"
cd "<repo root>" && cat "$SCRATCH/wp-x-taskname.md" | codex exec \
  --sandbox workspace-write \
  --output-last-message "$SCRATCH/wp-x-report.md" \
  > "$SCRATCH/wp-x-run.log" 2>&1
```

To pipe multiple files in as one prompt (e.g. instructions plus reference docs), concatenate
them into the pipe rather than interpolating any of them into a quoted argument:

```bash
{ cat "$SCRATCH/wp-x-prompt.md"; cat "$SCRATCH/wp-x-reference-a.md"; cat "$SCRATCH/wp-x-reference-b.md"; } \
  | codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=high \
    --output-last-message "$SCRATCH/wp-x-report.md" \
  > "$SCRATCH/wp-x-run.log" 2>&1
```

## Flags

| Flag | Purpose |
|---|---|
| `--sandbox workspace-write` | Implementation tasks — file writes allowed |
| `--sandbox read-only` | Review and planning — writes are structurally impossible |
| `--output-last-message <file>` | Write only the final report to a clean file |
| `-m <model>` | Override the default model for one invocation |
| `-c model_reasoning_effort=high` | Set reasoning effort (Sol `high`, Luna `xhigh` — §1) |
| `-c 'sandbox_workspace_write.network_access=true'` | Allow network from a workspace-write sandbox (needed for MCP calls) |


## Resuming a session

`codex exec resume <session-id>` continues an existing session with its full accumulated
context. **Use it for one job: recovering a run that died on `ERROR: Your workspace is out of
credits`.** Top up or switch the Codex account, then resume — the switched account picks the
session up mid-task (cross-account resume verified live 2026-08-28), so a review that died at
300k tokens continues from 300k, not from zero.

Every other task starts a **fresh `codex exec`** with its own spec: a new build, a new plan, a
fresh diff-review pass, and **each round of a fix loop** — so each run's context stays clean and
scoped to that task.

The session id is the `session id: <uuid>` line in the run-log `--------` banner. Capture it
from any run that might hit the credit wall.

```bash
cat "$SCRATCH/wp-x-fix.md" | codex exec resume <session-id> \
  -m gpt-5.6-luna -c model_reasoning_effort=xhigh -c 'sandbox_mode="workspace-write"' \
  --output-last-message "$SCRATCH/wp-x-fix-report.md" - > "$SCRATCH/wp-x-fix-run.log" 2>&1
```

`resume` takes the session id positionally, has **no `--sandbox` flag** (pass
`-c 'sandbox_mode="workspace-write"'` or `="read-only"`), and reads the follow-up prompt from
stdin with a trailing `-`. (`codex resume` without `exec` is the interactive TUI picker — a
different command.)

## Failure mode: MCP write actions

`codex exec` runs with `approval: never`. Some MCP **write** tools require a per-call approval
it cannot grant non-interactively, so the call fails while read-only calls to the same server
succeed in the same run. Don't keep tuning the invocation — fall back to an already
authenticated CLI (e.g. `wrangler` for Cloudflare) and perform the write directly.

`-c approval_policy="never"` does **not** lift this. The gate is per-tool, decided independently
of the approval policy, so the policy knob looks like the fix and changes nothing. If a required
MCP write is blocked, use an already-authenticated CLI where one exists and report the deviation.

## Browser and computer control

Any Codex model, including Luna, may handle a task that needs live browser or desktop interaction.
Use the native Chrome-use and Computer-use skills/plugins by default. Tell the selected model the
purpose, target environment, authentication state, and evidence to collect.

The capabilities do not change task authorization. Follow `Subagent-Orchestration.md` for
testing restrictions, and restate the applicable passive-only, local-dev, impersonation,
authentication, and disclosure requirements in every browser/computer prompt. A real sign-in click
remains a human action; report an auth or configuration blocker instead of routing around it.

Example invocation shape (select the model required by the task):

```
cat <prompt> | codex exec \
  -m <model> \
  --output-last-message <report> > <run.log> 2>&1
```

Choose sandbox and approval flags from the task's authorization policy. Browser access alone does
not authorize production mutations or repository writes. Background the run when it needs to
continue asynchronously, then read the report file and independently verify its claims.

## Optional Chrome control via `chrome-devtools-mcp`

`chrome-devtools-mcp` remains an alternative for Chrome-only tasks when the user explicitly asks
for it. It is opt-in and not the default browser-control path. Attach it to the human-authenticated
Chrome over CDP, passing the server per run so persistent Codex configuration stays unchanged:

```bash
cat <prompt> | codex exec --dangerously-bypass-approvals-and-sandbox \
  -m <model> \
  -c 'mcp_servers.chrome_devtools={command="npx",args=["-y","chrome-devtools-mcp@latest",\
      "--browserUrl=http://127.0.0.1:9333"],startup_timeout_sec=180}' \
  --output-last-message <report> > <run.log> 2>&1
```

The unsandboxed flag is required for MCP browser measurements that use `evaluate_script`. Apply
the browser-testing restrictions in `Subagent-Orchestration.md`, including the prompt
restriction block and the orchestrator's repo snapshot before the run. Use this method only when
the user names `chrome-devtools-mcp`; otherwise use the native Codex skills/plugins.

## Failure mode: silent stdin hang from shell-argument corruption

If the prompt is passed as a positional `"$(cat file)..."` argument inside a double-quoted
Bash string — especially one that also has hand-typed prose quoting real code (e.g. a review
brief that quotes `${assetId}`-style snippets from the file being reviewed) — bash expands
those literal `${...}` sequences as shell variable references *before* `codex exec` ever sees
them, silently evaluating unset ones to empty strings and corrupting the argument. `codex exec`
then falls back to reading its prompt from stdin, prints `Reading additional input from
stdin...` in its log, and hangs forever, because a backgrounded/redirected invocation has no
interactive stdin to read. CPU stays near-idle and the process just sits there — it looks like
a slow model call, not a hang, unless you check the log for that specific line.

**Diagnose**: `ps aux | grep codex` (process alive, low accumulated CPU time relative to wall
clock) plus `grep "Reading additional input from stdin" <run.log>`.

**Fix**: never interpolate prompt text — especially anything containing `${` or backticks —
into a quoted shell argument. Pipe it via stdin instead, with no positional `PROMPT` argument
at all (`codex exec` reads its entire prompt from stdin when none is given): `cat file | codex
exec [flags] > out.log 2>&1`, or `{ cat a; cat b; } | codex exec [flags] > out.log 2>&1` for
multiple files. `cat`'s output is inert to the shell — it is never re-scanned for `${...}` or
backtick expansion. See the spawn-shape examples above, which use this pattern.
