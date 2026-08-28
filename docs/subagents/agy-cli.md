# Agy (Antigravity) CLI mechanics

Loaded on demand from `docs/Subagent-Orchestration.md` §3a. Verified live 2026-07-24, including
a real accept-edits build test.

Agy is **Google's Antigravity CLI** (<https://antigravity.google/docs/cli/using>) — the binary
`agy` at `/Users/tingruilee/.local/bin/agy`, also reachable as the `antigravity` symlink. It is
spawned as a `Bash` subprocess like Codex, but shares none of its flags. **There is no
`gpt-5.6-agy` model** — the account rejects that id.

`agy agents` lists configured named agents (empty on this account). "Agy" is this project's
name for whatever the CLI produces, the same way Sol/Terra/Luna name specific `gpt-5.6-*`
models.

## Planning (read-only)

```bash
agy --mode plan --effort high --sandbox --dangerously-skip-permissions \
  --print-timeout 10m0s -p "..." > report.md 2> run.log
```

- `-p` / `--print` / `--prompt` — one non-interactive prompt, Agy's equivalent of
  `codex exec "..."`. The response goes to **stdout**; there is no `--output-last-message`, so
  redirect stdout to the report and stderr to a separate log.
- `--mode plan` — read/plan-only, the equivalent of Codex's `--sandbox read-only`.
- `--sandbox` — OS-level terminal restrictions. A planning-only safety layer; see the build
  section, where it must be dropped.
- `--effort low|medium|high` — use `high` for real planning work.
- `--model <name>` — optional. `agy models` lists the account roster (2026-07-24:
  `gemini-3.6-flash-{high,medium,low}`, `gemini-3.5-flash-{high,medium,low}`,
  `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`). The configured default is `gemini-3.6-flash-high`; pass it explicitly
  rather than relying on the default, but don't invent a preference for a different underlying
  model unasked.
- `--print-timeout <duration>` — default `5m0s`; `10m0s` handled a real cross-system
  architecture plan.

Smoke-test any new invocation shape before spending a long task on it:

```bash
agy --mode plan --effort low -p "reply with exactly: agy reachable"
```

## Building (`--mode accept-edits`)

```bash
agy --model gemini-3.6-flash-high --mode accept-edits --effort high \
  --dangerously-skip-permissions \
  --add-dir "<absolute repo root>" \
  --print-timeout 10m0s \
  -p "..." > report.md 2> run.log
```

Both differences from the planning invocation are **required, not stylistic**:

1. **Drop `--sandbox`.** With `--mode accept-edits` it still blocks real file writes: the CLI
   replies "done" and the file on disk is unchanged, with nothing printed to stdout *or*
   stderr. Scope restriction for builds comes from `--add-dir`, not `--sandbox` — don't re-add
   it "just to be safe."
2. **Pass `--add-dir "<repo root>"` as an absolute path.** Agy's
   `~/.gemini/antigravity-cli/settings.json` holds a `trustedWorkspaces` allowlist (2026-07-24:
   `/Users/tingruilee` and two `Documents/Codex/...` paths). Writes inside a trusted path
   succeed with just `--mode accept-edits --dangerously-skip-permissions`; writes **outside**
   it — this repo lives on another volume entirely — are silently discarded unless `--add-dir`
   grants the directory for that session.

Verified by direct test both ways: a `/tmp` scratch write silently failed three times across
invocation variants; the identical prompt under `/Users/tingruilee` worked immediately; the
identical prompt against the real repo path with `--add-dir` also worked immediately.

## The three silent failure modes

None of these print an error. All of them look like success.

| Symptom | Cause | Fix |
|---|---|---|
| Empty stdout, run did nothing | A shell tool call needed the `command` permission, which headless mode can't prompt for, so it was auto-denied. **The only signal is in stderr:** `jetski: no output produced — a tool required the "command" permission…` | `--dangerously-skip-permissions` on any headless task that reads files via `grep`/`cat`/`find` |
| "done", file unchanged | `--sandbox` passed alongside `--mode accept-edits` | Drop `--sandbox` for builds |
| "done", file unchanged | Target outside `trustedWorkspaces` | `--add-dir "<absolute repo root>"` |

So: check **stderr**, not just whether the report file has content, and confirm every Agy build
actually touched disk (`git status`, read the file back) before trusting its self-report. Then
run the full §5 gate as with any other builder.

## Chrome automation via `chrome-devtools-mcp` (verified 2026-08-27)

Agy has no native browser tool — only `read_url_content` (static HTTP, no JS) and `search_web`.
But it *can* drive a real Chrome through the
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) MCP server.

Tools exposed (~29): `navigate_page`, `new_page`, `select_page`, `list_pages`, `close_page`,
`take_snapshot`, `take_screenshot`, `click`, `hover`, `drag`, `fill`, `fill_form`, `type_text`,
`press_key`, `upload_file`, `handle_dialog`, `wait_for`, `evaluate_script`, `resize_page`,
`emulate`, `list_network_requests`, `get_network_request`, `list_console_messages`,
`get_console_message`, `performance_start_trace`, `performance_stop_trace`,
`performance_analyze_insight`, `lighthouse_audit`, `take_heapsnapshot`.

Two ways to run it. **Option B** lets the MCP server launch its own throwaway Chrome — simplest,
but logged into nothing. **Option A** attaches the MCP server to a Chrome a human already
signed in — this is what gives Agy an authenticated Quincy session, and it's the one that
actually works reliably.

### Rules that apply to both

- **`--mode plan` does not execute tools** — it only drafts a plan and waits for a "Proceed"
  click. Use **`--mode accept-edits`** (the build invocation shape; `--add-dir` only matters if
  the task also writes repo files).
- **Model and effort must agree.** `--model gemini-3.7-flash-high` (current default; `3.6` and
  `3.5` also on the roster) rejects `--effort medium`/`low` with `invalid model selection …
  conflicts with --effort` — the tier is baked into the model id, so always pass `--effort high`
  with a `*-high` model.
- **Background the run through the harness (`Bash` `run_in_background: true`), never a bare
  `nohup agy … &`.** The prompt travels as a `--print=` argument, not on stdin (see the
  large-prompt section below), so a harness-supervised background launch has no stdin dependency
  to trip on: the process keeps running and the orchestrating session is free while Agy works
  (2026-08-28: a long QA-matrix run stayed healthy and progressing many minutes past the ~10 s
  mark where `nohup &` dies). A bare `nohup agy -p … &` is the thing that fails — detaching from
  the shell closes stdin, print mode ends early, and it exits in ~10 s with empty stdout *and*
  stderr, task half-done, and can orphan an Option-B Chrome (Option A's Chrome is the human's own
  process, nothing to orphan). Give `--print-timeout` real room — `10m0s`+ for a spec'd QA
  matrix, more for a long one. In Option A the human signs in *before* Agy spawns, so there is no
  in-run wait to worry about.
- **Agy is the pipeline's tester** (§2.8) and carries danger-mode (§2.9) and YOLO-mode (§2.10)
  sanction as of 2026-08-27 — it took the testing role over from Luna after a trial pass on the
  TB4C QA matrix. Planning and building still never go to Agy (§2.6). Every QA finding still
  clears the full §5 gate in the orchestrating session — the report is not ground truth.

### Option A — attach to a human-authenticated Chrome (verified 2026-08-27)

A human starts a dedicated Chrome, signs into local dev once, and leaves it running. Agy's MCP
server attaches over CDP; the session lives in that Chrome regardless of whether any `agy`
process is alive.

```bash
# 1. dedicated Chrome — NOT your everyday profile. Pick a free port (9222 is often already
#    taken by another Chrome; this project used 9333). A non-default --user-data-dir is
#    mandatory: modern Chrome refuses --remote-debugging-port on the default profile.
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.cache/agy-quincy-chrome" \
  --no-first-run --no-default-browser-check --disable-sync \
  http://localhost:8787 > /tmp/agy-chrome.log 2>&1 &
curl -sS http://127.0.0.1:9333/json/version   # confirm the endpoint is up

# 2. human signs into http://localhost:8787 in that window (Continue with Google → seed admin).
#    Verify: curl http://127.0.0.1:9333/json  → the localhost:8787 tab is listed.

# 3. point the MCP server at it
agy mcp remove chrome-devtools 2>/dev/null
agy mcp add chrome-devtools npx -y chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9333
agy mcp list

# 4. run tasks — harness-backgrounded (Bash run_in_background: true), -p kept last,
#    --print-timeout sized to the task (10m0s+ for a QA matrix)
agy --model gemini-3.7-flash-high --mode accept-edits --effort high \
  --dangerously-skip-permissions --print-timeout 30m0s \
  -p "$(cat "$SCRATCH/task.md")" > report.md 2> run.log
```

Smoke test result: Agy attached, `list_pages` found the tab, `evaluate_script` on
`fetch('/api/auth/get-session')` returned the real session (`mjj2332@gmail.com`, `role: admin`,
`impersonatedBy: null`), and `/admin` rendered the full admin UI — no redirect. The better-auth
session cookie lasts ~7 days; re-sign-in is one click in the same window.

- **Local dev is the usual target.** Local-dev Google sign-in works for `localhost:8787`
  (redirect registered 2026-08-19). For production danger-mode (passive, §2.9) or YOLO-mode
  (mutating via impersonation, §2.10), the human points this same dedicated Chrome at
  `https://quincy.flamingfire.my` and signs in there once instead — the invocation is
  identical, the containment is entirely prompt-level plus (for YOLO) server-side impersonation.
- **Do NOT point this at your everyday Chrome profile.** Chrome blocks `--remote-debugging-port`
  on the default profile anyway, and attaching automation there would hand Agy your entire
  Google session (Gmail, Drive, …). The dedicated profile is the containment boundary. The
  Quincy session is a `localhost` better-auth cookie, not a Google cookie — the dedicated
  profile holds it after one sign-in; Google is only touched during the OAuth handshake.
- **The human does the Google click** (`feedback-no-autonomous-google-signin`) — Agy never runs
  the OAuth flow itself.

### Option B — MCP server launches its own Chrome

```bash
agy mcp add chrome-devtools npx -y chrome-devtools-mcp@latest
agy --model gemini-3.7-flash-high --mode accept-edits --effort high \
  --dangerously-skip-permissions --print-timeout 9m0s \
  -p "Do not write files or draft a plan. Use the chrome-devtools MCP tools now: navigate_page
      to <url>, take_snapshot, report ..." > report.md 2> run.log
```

Smoke test (navigate `example.com` → `take_snapshot` → report `h1`/`title`) passed.

- **First run downloads Chrome for Testing via `npx`** — give `--print-timeout` room (`9m0s`+).
- Browser is persistent by default (`~/.cache/chrome-devtools-mcp/chrome-profile`, `--isolated`
  is false) but **logged into nothing**. Fine for public sites, `prototype.`/marketing pages,
  Lighthouse/perf audits, unauthenticated smoke checks. Does **not** close the Quincy local-auth
  gap — and forging the better-auth cookie stays the
  [Subagent-Orchestration.md](../Subagent-Orchestration.md) §6-forbidden move.
- Coordinating a human sign-in *inside* one non-interactive `-p` turn is fragile — that's what
  Option A exists for.

## Passing a large prompt safely — `-p` has no stdin equivalent

Agy's `-p` takes a positional argument only; unlike `codex exec`, there is no stdin mode to fall
back to (`--print=` with an empty value and a piped prompt errors `empty prompt`; see
[codex-cli.md](codex-cli.md)'s stdin-hang failure mode for why the difference matters there).
`--print`/`-p` also consumes the *next* token as its value, so keep it **last** on the command
line — with `--mode`/`--effort`/etc. before it — or a following flag becomes the prompt and Agy
errors (`--print took "--mode" as its prompt`). The invocation examples above already put `-p`
last; preserve that when you reorder flags.
For a large prompt, `-p "$(cat "$SCRATCH/prompt.md")"` is safe **as long as the entire argument
is that one substitution and nothing else** — command-substitution output is not re-scanned for
further `$`/backtick expansion, so backticks or `${...}` inside the file pass through literally
(verified live: a file containing `` `writeAutoHdrFinal()` `` and `${assetId}` came through
unexpanded). The danger is mixing hand-typed prose into the *same* double-quoted argument as the
substitution — e.g. `"$(cat a)... some ${literal} text ...$(cat b)"` — since that hand-typed
`${literal}` is parsed as a real expansion by the outer quotes, not as inert text. Keep each `-p`
argument to a single clean substitution (concatenate multiple source files into one scratchpad
file first, then `cat` that one file) rather than assembling the prompt inline.
