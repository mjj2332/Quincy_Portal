# Codex CLI mechanics (Sol / Terra / Luna)

Loaded on demand from `docs/Subagent-Orchestration.md` §3. Verified live 2026-07-19.

`codex exec` runs the real Codex CLI as an OS subprocess via `Bash` — OpenAI's model, its own
sandbox, output read back from a file. It is not the `Agent` tool.

```bash
codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=medium "..."
```

Sol's effort is **medium** and Luna's is **xhigh** — both fixed by `Subagent-Orchestration.md` §1,
which is the source of truth; the values here just match it.

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
  | codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=medium \
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
| `-c model_reasoning_effort=medium` | Set reasoning effort (Sol `medium`, Luna `xhigh` — §1) |
| `-c 'sandbox_workspace_write.network_access=true'` | Allow network from a workspace-write sandbox (needed for MCP calls) |

- **The account default drifted 2026-07-29**: `~/.codex/config.toml`'s `model` line was found set
  to `gpt-5.6-luna`, not `gpt-5.6-terra` as this doc previously assumed — confirmed live when two
  consecutive `codex exec` calls with no `-m` flag both banner-printed `model: gpt-5.6-luna`
  (visible in the run log's `--------` header block, always worth checking after any invocation
  that matters). The account default is **not reliable** and can change outside this session's
  control. **Always pass `-m gpt-5.6-luna` explicitly** for any Luna invocation (build, diagnostics,
  testing) rather than trusting the account default — the same applies for Sol (draft, review),
  pass `-m` for that too. Terra has no role in the pipeline as of 2026-08-22 (see
  `Subagent-Orchestration.md` §1, §2.5) and is not spawned. Don't skip re-checking the run log's
  `model:` line after a spawn just because this was fixed once; a config default can drift again.
- There is **no `--reasoning-effort` flag** — effort goes through `-c model_reasoning_effort`.
- There is **no `--no-terminal` flag** on `codex exec`; that belongs to `acpx`'s Claude-session
  wrapper.

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
