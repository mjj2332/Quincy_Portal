# Codex CLI mechanics (Sol / Terra / Luna / Astra)

Loaded on demand from `Subagent-Orchestration.md` §3. Updated 2026-09-13.

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
**For a Chrome measurement pass, `chrome-devtools-mcp` is the default** — that reverses the earlier
guidance, and the head-to-head data behind the reversal is in the section below. Use the native
Chrome-use plugin when the task needs the owner's real logged-in browser and no viewport control.
Computer-use (desktop, non-browser) is unaffected: native remains the only path. Tell the selected
model the purpose, target environment, authentication state, and evidence to collect.

A UI browser pass is stage 1 of two (`Subagent-Orchestration.md` §2a): the design-reviewer reads
Luna's output next, so every brief states the report contract — screenshots saved as files in one
folder, named per viewport and open state, and a PASS/FAIL table whose every row carries the
measurement and the screenshot that shows it.

The capabilities do not change task authorization. Follow `Subagent-Orchestration.md` for
testing restrictions, and restate the applicable passive-only, local-dev, impersonation,
authentication, and disclosure requirements in every browser/computer prompt. Every session is
human-made and secrets stay in the environment (`Subagent-Orchestration.md` §2): a missing session
or a `.dev.vars` lookup is a blocker to report, never a gap to close by hand.

Example invocation shape (select the model required by the task):

```
cat <prompt> | codex exec \
  -m <model> \
  --output-last-message <report> > <run.log> 2>&1
```

Choose sandbox and approval flags from the task's authorization policy. Browser access alone does
not authorize production mutations or repository writes. Background the run when it needs to
continue asynchronously, then read the report file and independently verify its claims.

## Chrome control: the two paths, measured

Both paths were run head-to-head on 2026-09-13 — the same #111 navigation-rail measurement spec,
the same model (`gpt-5.6-luna`), the same `xhigh` effort, the same local dev server. This is the
only direct comparison we have, so it is the basis for the default above.

| | native Chrome-use | `chrome-devtools-mcp` |
|---|---:|---:|
| Wall clock | 33m 16s | **13m 54s** |
| Tokens | 1,130,631 | **244,843** |
| Browser tool calls | 312 (`cua_repl`) | 188 (`chrome_devtools`) |
| Spec items completed | 2 of 5 | **5 of 5** |

**2.4x faster on 22% of the tokens, and only the MCP run finished the task.** Both reported the
same verdict and the same confirmed defect, and their overlapping colour measurements agreed to
three decimals when re-derived independently, so the gap is coverage and cost, not accuracy.

What decided it, and what to expect from each:

- **Native lost three of five spec items.** Its viewport control failed with
  `Codex auth token is unavailable` while its measurement channel kept working, so every
  responsive-width check was simply unavailable — and the failure was silent until the final
  report. Do not pick the native path for layout or breakpoint work.
- **Native burned tokens building its own instrument.** Rather than measure through the plugin it
  wrote a standalone CDP client in Python and computed linear-light sRGB blends there. Precise, but
  it is most of the 4.6x token difference, and it means "native" in practice often means
  "native plus self-built tooling".
- **Native's one advantage is authentication.** It attaches through the Codex Chrome extension to a
  browser where that extension is installed — in practice the owner's everyday Chrome — so it
  inherits real logins with no setup. That is also its risk: the run is inside the owner's own
  browser, so the prompt must forbid touching tabs it did not open and forbid reading history,
  saved passwords and autofill. The extension is **not** in a throwaway `--user-data-dir` profile,
  so the debug-profile recipe below does not serve the native path.
- **MCP needs a prepared browser but then behaves.** Launch Chrome with a debugging port and put a
  session in it first (recipe in `agy-cli.md` §Option A). It then runs in a throwaway profile, so
  the owner's browsing is never in scope, and viewport control works. Its known weakness: it could
  not save screenshot files (it rejected the workspace path), so evidence stays inline in the
  transcript.
- **MCP read the spec more critically.** It caught an error in the brief — it was asked to measure
  a group label's contrast and found the element is `.sr-only`, a clipped 1x1 box that never
  paints, so the requested measurement was meaningless. The native run measured the computed colour
  of invisible text and reported it as a pass.

Invocation, unchanged:

```bash
cat <prompt> | codex exec --dangerously-bypass-approvals-and-sandbox \
  -m <model> \
  -c 'mcp_servers.chrome_devtools={command="npx",args=["-y","chrome-devtools-mcp@latest",\
      "--browserUrl=http://127.0.0.1:9333"],startup_timeout_sec=180}' \
  --output-last-message <report> > <run.log> 2>&1
```

The unsandboxed flag is required for MCP browser measurements that use `evaluate_script`. The
native path needs it too, since the Chrome plugin spawns a native host and writes session state
under `~/.codex`. Apply the browser-testing restrictions in `Subagent-Orchestration.md`, including
the prompt restriction block and the orchestrator's repo snapshot before the run.

Caveats on the numbers, so they are not over-read: one comparison, one task, one machine; the two
runs overlapped for part of their duration and so competed for CPU; and they inherited different
(both human-created) sessions, so a role- or capability-dependent disagreement would be the session
and not the mechanism. Re-measure before treating the ratios as stable.

### Renditions cannot be generated on local dev

Worth knowing before specifying any browser task that needs a photo preview, a Lightbox, or a
thumbnail: rendition generation calls Cloudflare Image Resizing (`/cdn-cgi/image/...`) against
`APP_ORIGIN` and requires `internal=ok` in the response's `cf-resized` header. That endpoint exists
only on the Cloudflare edge, and `workers/background/src/renditions.ts` has no local bypass. On
`wrangler dev` every rendition therefore fails, `renditionStatus` stays `"processing"` forever, and
the Lightbox opener stays disabled — `PhotoGrid.tsx` sets `tabIndex={-1}` and `aria-disabled` on a
pending tile.

Both runs above hit this wall and both correctly refused to work around it. Running the background
worker does not help. To exercise a Lightbox locally, seed `asset_renditions` rows plus matching R2
objects (`thumb` and `web` are both required for `"ready"`, content type `image/webp` or
`image/jpeg`, key from `renditionR2Key`, `spec_version` `v1`) — and say plainly in any report that
the renditions were seeded, since that path tests the viewer and not the rendition pipeline.

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
