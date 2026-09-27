# Agy (Antigravity) CLI mechanics

Loaded on demand from `Subagent-Orchestration.md` §3a. Browser pass on `chrome-devtools-mcp` at
medium effort since 2026-09-28; CLI mechanics verified live 2026-07-24, including a real
accept-edits build test.

Agy is **Google's Antigravity CLI** (<https://antigravity.google/docs/cli/using>) — the binary
`agy` at `/Users/tingruilee/.local/bin/agy`, also reachable as the `antigravity` symlink. It is
spawned as a `Bash` subprocess like Codex, but shares none of its flags. **There is no
`gpt-5.6-agy` model** — the account rejects that id.

`agy agents` lists configured named agents (empty on this account). "Agy" is this project's
name for the CLI running **`gemini-3.8-flash-medium` at `--effort medium`** — the owner's choice
for the browser pass (2026-09-28; `-high` at `high` before that). The tier is baked into the model
id, so the two flags always move together. Pass both on every run.

**Agy's job is stage 1 of every UI browser pass** ([Subagent-Orchestration.md](Subagent-Orchestration.md)
§2a), driving the dedicated debugging Chrome through `chrome-devtools-mcp`, whose native `drag`
moves Gantt bars. The recipe is [§Browser pass](#browser-pass-the-default-invocation) below.

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
- `--model` — always explicit, with the tier matching `--effort` (§Rules that apply to both). `agy models` lists the account roster
  (verified 2026-09-27 on `agy` 1.2.7: `gemini-3.8-flash-*`, `gemini-3.7-flash-*`,
  `gemini-3.6-flash-*`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`,
  `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`). The roster shifts without notice; if
  `gemini-3.8-flash-medium` ever drops off, the run fails — report it to the owner rather than
  picking a substitute.
- `--print-timeout <duration>` — default `5m0s`; `10m0s` handled a real cross-system
  architecture plan. On the print-mode shutdown hang (below) this also bounds dead wait time, so
  don't set it lavishly wide on a run you aren't watching.

Smoke-test any new invocation shape before spending a long task on it:

```bash
agy --mode plan --effort low -p "reply with exactly: agy reachable"
```

## Building (`--mode accept-edits`)

```bash
agy --model gemini-3.8-flash-high --mode accept-edits --effort high \
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
| Empty report file, non-zero exit after a long delay | Agy started a command it tracks as running async (e.g. it launched `wrangler dev` itself) and print mode waited for that command until `--print-timeout` | Start servers yourself; tell Agy the server is already up. The report is still in the conversation DB — recover it (next section). |

So: check **stderr**, not just whether the report file has content, and confirm every Agy build
actually touched disk (`git status`, read the file back) before trusting its self-report. Then
run the full §5 gate as with any other builder.

## Print-mode shutdown hang — a long run whose report never lands

`agy --print` normally runs one turn and exits within seconds of finishing (verified 2026-08-28:
trivial prompt 8 s, a shell+read+write build 20 s, a `chrome-devtools` navigate+snapshot 30 s).
**A command Agy started and left tracked as running async breaks that.** When the turn ends with
such a command still alive, Agy does not exit — it poll-loops one model call every 60 s until
`--print-timeout` expires, then exits non-zero with empty stdout, discarding the buffered
response. The conversation and any files it wrote are still saved; only the printed report is lost.

Reproduced: a `-p` run told to start `python3 -m http.server` and not stop it hung the full
`--print-timeout`, logging `printmode.go:521] Print mode: timed out after N polls (printed=2)`;
the same run told to stop the server before replying exited cleanly in ~11 s. The TB4E QA matrix
hit this — Agy ran `npx wrangler dev --port 8787` itself, finished the matrix and report in
~7 min, then sat in the keepalive loop for 22 min until killed (0-byte report, ~22 wasted calls).

**Keep long-running processes out of Agy's hands.** Bring `wrangler dev` up yourself before
spawning Agy and say in the spec that the server is already running. If a task genuinely needs
Agy to launch a background process, tell it to kill that process before it sends its final reply.

**Recover a lost report** from Agy's conversation DB — the report survives as the last step even
when the file is empty. The step payload is protobuf with the report as a plain-text field; pull
the printable runs and start at the first heading:

```bash
DB=$(ls -t ~/.gemini/antigravity-cli/conversations/*.db | head -1)   # newest run — or match mtime
python3 - "$DB" <<'PY'
import re, sqlite3, sys
db = sys.argv[1]
idx = sqlite3.connect(db).execute("SELECT max(idx) FROM steps").fetchone()[0]   # last step = final reply
payload = sqlite3.connect(db).execute("SELECT step_payload FROM steps WHERE idx=?", (idx,)).fetchone()[0]
text = "\n".join(r.decode("utf-8", "replace") for r in re.findall(rb"[\x09\x0a\x20-\x7e]{6,}", payload))
m = re.search(r"#\s+\w", text)                       # first markdown-ish heading
print(text[m.start():] if m else text)
PY
```

Protobuf tag bytes land as stray single chars between runs (e.g. `Fixture \n DELETE ME` where an
em dash was) — cosmetic, fix by hand.

`--output-format stream-json` is a lighter guard: it streams `step_update` events live (a watcher
sees progress and turn completion as they land) and emits a final `result` event with
`status:"ERROR"` on the hang instead of a silent 0-byte file. It still doesn't recover the answer
text — the DB does.

## Browser pass: the default invocation

Agy drives the dedicated debugging Chrome on 9333 through **`chrome-devtools-mcp`** at medium
effort (owner decision, 2026-09-28; §Option A below sets that Chrome up). It replaced
`huashu-chrome` the same day. On the #221 pass D brief, against the same bundle and fixture:

| Agy (high effort) | `huashu-chrome` | `chrome-devtools-mcp` |
|---|---|---|
| Wall time, tool calls | 12 min, 212 | 18½ min, 313 |
| Failed tool calls | 14 (11 `[NO_TAB]`) | 2 |
| Writes left behind | 2 | 0 |
| Keyboard, focus, hover, 390px | synthetic or blocked: unmeasured | trusted: measured, and caught a Cancel-focus defect |

Medium effort is unmeasured on a full pass: hold its first run against the right-hand column.

Preconditions, each checked before spawning (Agy starts none of them — see the shutdown hang above):

1. `wrangler dev` on 8787 serving the build under test. It serves whichever checkout started it,
   normally the main checkout; with the owner's OK, detach that checkout to the branch under test
   (`git checkout --detach <branch>`), rebuild web (`npm run build -w @quincy/web`), and restore
   `main` afterwards. A worktree cannot run its own server (no `.dev.vars`, no local D1 session).
2. The dedicated Chrome is up and signed in: `curl -sS http://127.0.0.1:9333/json/version`
   answers and `curl -sS http://127.0.0.1:9333/json` lists a `localhost:8787` page. The owner
   starts it and does the sign-in (§Option A).
3. `~/.gemini/config/mcp_config.json` has `chrome-devtools` with `--browserUrl=http://127.0.0.1:9333`
   and `--workspace=<repo root>/qa-evidence` (§Rules that apply to both).
4. The page under test is **hard-reloaded** at the start of the brief, and Agy reports the loaded
   `index-*.js` name alongside the one the server now serves. A tab left open across a rebuild
   runs the old bundle, and a pass against it is void (#255 pass G).

```bash
agy --model gemini-3.8-flash-medium --mode accept-edits --effort medium \
  --dangerously-skip-permissions \
  --add-dir "<absolute repo root>" \
  --print-timeout 40m0s \
  -p "$(cat "$SCRATCH/browser-pass.md")" > report.md 2> run.log
```

- Launch it with `Bash` `run_in_background: true`. `-p` stays last.
- **Permission.** The owner added `Bash(agy:*)` to `.claude/settings.local.json` (2026-09-28). It
  matches only a command line that *starts* with `agy`: a wrapper that waits for a previous run
  (`while …; do sleep; done; agy …`) is not covered and is refused. Queue a second run by launching
  it after the first one's completion notification, not from a waiting script.
- The brief's first line names the browser: "Drive Chrome only through the `chrome-devtools` MCP
  tools." Afterwards, confirm from the conversation DB that no other browser tool ran.
- **Containment.** Agy works only in pages it opens itself (`new_page`, then that `pageId` on every
  call), on `http://localhost:8787` only, and closes them at the end. The dedicated profile is the
  boundary (§Option A).
- **Moves: `drag`.** It takes two uids from a fresh `take_snapshot`: `from_uid` is the bar's
  `button` (its accessible name carries the dates), `to_uid` is the destination day's header
  `StaticText` in the timeline (e.g. `"Tue 29"`), which must be on screen, so scroll the timeline
  first. One call is a trusted press-move-release (verified 2026-09-28: one `drag`, one real
  `PATCH` 200). It drops the bar's *centre* on that header's centre, so the landed dates are not
  the header's day: the row reads them from the `PATCH` (`list_network_requests` →
  `get_network_request`) or the bar's new accessible name.
- **Resizes and keyboard: `press_key`.** Resize grips are not in the accessibility snapshot, so
  `drag` cannot reach them. Resize through keyboard Adjust: `click` the bar, then `press_key`
  Space, S or E for the edge, the arrows, Enter or Escape. The keys are trusted, so focus rows are
  measured directly (`evaluate_script` → `document.activeElement`).
- **Mid-drag states** (the ghost, hint or chip while held) need the pointer down at screenshot
  time, which one `drag` call never leaves. For those rows only, the brief supplies an
  `evaluate_script` that dispatches `pointerdown` and stepped `pointermove`s, the screenshot runs,
  then a second script dispatches `pointerup`; the row says it was synthetic.
- **Hover:** `hover`. **Viewport:** `emulate` with `viewport: "390x844x2,mobile,touch"` on its own
  page, reset with `emulate` again before the wide rows.
- **Screenshots:** `take_screenshot` with a `filePath` under `qa-evidence/<pass>/screens/`. Confirm
  the files exist after the run.
- The brief carries the report contract of Subagent-Orchestration.md §2a — screenshots named per
  viewport and state, every PASS/FAIL row with its measurement and screenshot — plus local-dev
  only, no sign-in or sign-out, and restore anything it mutates.
- **Evidence per row.** Agy's tables overclaim unless the brief pins this down (#255 pass I: eight
  PASS rows cited screenshots of a different state, one screenshot was byte-identical to another,
  and the report still said "Could not verify: none"). The brief requires:
  - one screenshot file per state, taken while that state is on screen, named for it;
  - every PASS row cites the file for its own state, never a neighbouring one;
  - a state it could not reach or capture goes under **Could not verify**, by name, with the
    reason. A DOM-only fact (a live-region string, a computed colour) cites the `evaluate_script`
    output instead of a screenshot and says so.

  After the run, check the files yourself: `md5 -q qa-evidence/<pass>/screens/*.png | sort | uniq -d`
  must print nothing, and open the screenshots behind the rows the decision rests on (§2a).

### What the session still re-checks

Trusted keys, hover and viewports close most of the gap, but a measurer still passes rows its own
numbers fail: on #221 pass E Agy measured the dialog backdrop as `rgba(0,0,0,0)` and focus landing
on an unrelated bar, and marked both PASS. The session re-runs, with trusted CDP input in the same
Chrome, every synthetic mid-drag row and every row whose measurement contradicts its verdict: open
its own target with `Target.createTarget`, size it with `Emulation.setDeviceMetricsOverride`, drive
it with `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`. Layout defects a measurer measured
and passed (a street squeezed to zero width, an 860px dialog) are design-reviewer's to catch (§2a
stage 2).

### `huashu-chrome`: the fallback when the debugging Chrome is down

huashu drives the owner's *everyday* Chrome with no setup (`agy mcp list` shows
`huashu-chrome … npx -y huashu-chrome mcp --client gemini`). Its input is synthetic and its tabs sit
in the background, so every keyboard, focus, hover and narrow-viewport row is unmeasured and goes to
the session's re-check; it has no drag tool, so moves are an `eval` of pointer events. When it runs:

- **Containment.** The owner's everyday Chrome holds every login. The brief confines Agy to tabs it
  opens itself (`tabs` action `new`, a `label`, and that `tabId` on every call), to
  `http://localhost:8787` only, and never `focus: true`; it never reads, selects or closes another
  tab, never visits history, passwords or autofill, and closes its own tabs at the end.
- **Screenshots** need `full: true`: without it huashu writes a 60%-scale JPEG under the `.png`
  name (2026-09-28, 2304×1336).
- **`[NO_TAB]`** on a tab huashu just opened: open a fresh tab and retry once. If it recurs, the
  owner reloads the extension (`chrome://extensions` → reload); runs that hit it printed the
  extension v1.2.0 / CLI v1.2.1 mismatch warning.
- **Viewport.** It cannot resize the owner's window; one `window.open(url, name,
  "popup,width=390,height=844")` is the only narrow path, and Chrome blocks it on some runs.

## Why not the Antigravity browser agent

[Antigravity's browser](https://antigravity.google/docs/ide/browser) is a browser subagent that
drives its own separate Chrome profile, records its actions as video artifacts, and gates URLs
with an allowlist that starts as `localhost` only. The docs mark it and its
[separate profile](https://antigravity.google/docs/ide/separate-chrome-profile/) **"Available on:
Antigravity IDE"** — not the CLI — and it cannot attach to an existing Chrome, so a headless
`agy -p` run cannot reach a human-signed Quincy session through it. The CLI's own `browser_*`
tools remain untested for that. The headless paths are `chrome-devtools-mcp` (below) and the
`huashu-chrome` fallback (above).

## Chrome automation via `chrome-devtools-mcp` (verified 2026-08-27, re-verified 2026-09-27)

The browser pass's browser (§Browser pass above). Agy drives the dedicated debugging Chrome
through the [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) MCP
server (1.10.1 on 2026-09-28).

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
- **Model and effort must agree.** The tier is baked into the model id, and a mismatch errors
  `invalid model selection … conflicts with --effort`: `gemini-3.8-flash-medium` takes
  `--effort medium` (the browser pass; verified 2026-09-28), a `*-high` id takes `high`, a `*-low`
  id takes `low`.
- **Launch through the harness (`Bash` `run_in_background: true`).** The prompt travels as a
  `--print=` argument, not on stdin (see the large-prompt section below), so a harness-supervised
  background launch has no stdin dependency: the process runs and the orchestrating session stays
  free. A bare `nohup agy -p … &` is the one launch shape that fails this way — detaching from the
  shell closes stdin, print mode ends early, and it exits in ~10 s with empty stdout *and* stderr,
  task half-done, and can orphan an Option-B Chrome (Option A's Chrome is the human's own process,
  nothing to orphan). Size `--print-timeout` to the task (`10m0s`+ for a spec'd QA matrix) but not
  wider than you'll wait — on the print-mode shutdown hang it becomes dead time. For a long run,
  watch the conversation DB step count and kill once the final reply step lands rather than
  trusting a wide timeout. In Option A the human signs in *before* Agy spawns, so there is no
  in-run wait to worry about.
- **Give it a workspace root, or it cannot save files.** `chrome-devtools-mcp` (≥ 1.10) confines
  `take_screenshot`'s `filePath` and every other file write to the OS temp directory unless the
  client negotiates the MCP `roots` capability or the server gets `--workspace=<dir>`. `codex exec`
  does not negotiate roots, which is why Luna's #221 run got `Access denied: path … is not within
  any of the configured workspace roots` on every screenshot (the same failure recorded in
  codex-cli.md on 2026-09-13). **The fix is `--workspace="<absolute repo root>/qa-evidence"`** on
  the server's command line. Verified 2026-09-28 three ways: a bare MCP client (the same call
  failed without the flag and saved with it), then Agy and Luna end to end, each saving a real
  screenshot of the signed-in Portal into `qa-evidence/`.
  - **Agy** carries the flag in its saved server entry (`~/.gemini/config/mcp_config.json`, set by
    the `agy mcp add` in §Option A step 3). `agy mcp add` stores the quoted path as one argument
    despite its spaces; read that file, not `agy mcp list`, to confirm.
  - **Codex** has no saved `chrome-devtools` server, so every `codex exec` passes it through `-c`
    and must carry the flag each time (invocation in codex-cli.md). Put the absolute path in the
    string: inside a single-quoted `-c`, `$PWD` stays literal.
- **Agy tests; it never plans or builds.** Every finding still clears the full §5 gate in the
  orchestrating session — the report is not ground truth.

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
agy mcp add chrome-devtools npx -y chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9333 \
  "--workspace=<absolute repo root>/qa-evidence"
agy mcp list

# 4. run tasks — harness-backgrounded (Bash run_in_background: true), -p kept last,
#    --print-timeout sized to the task (10m0s+ for a QA matrix)
agy --model gemini-3.8-flash-medium --mode accept-edits --effort medium \
  --dangerously-skip-permissions --print-timeout 30m0s \
  -p "$(cat "$SCRATCH/task.md")" > report.md 2> run.log
```

Smoke test result: Agy attached, `list_pages` found the tab, `evaluate_script` on
`fetch('/api/auth/get-session')` returned the real session (`mjj2332@gmail.com`, `role: admin`,
`impersonatedBy: null`), and `/admin` rendered the full admin UI — no redirect. The better-auth
session cookie lasts ~7 days; re-sign-in is one click in the same window.

- **Local dev is the usual target.** Local-dev Google sign-in works for `localhost:8787`
  (redirect registered 2026-08-19). For production danger-mode (passive) or YOLO-mode (mutating
  via impersonation) the human points this same dedicated Chrome at
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
agy --model gemini-3.8-flash-medium --mode accept-edits --effort medium \
  --dangerously-skip-permissions --print-timeout 9m0s \
  -p "Do not write files or draft a plan. Use the chrome-devtools MCP tools now: navigate_page
      to <url>, take_snapshot, report ..." > report.md 2> run.log
```

Smoke test (navigate `example.com` → `take_snapshot` → report `h1`/`title`) passed.

- **First run downloads Chrome for Testing via `npx`** — give `--print-timeout` room (`9m0s`+).
- Browser is persistent by default (`~/.cache/chrome-devtools-mcp/chrome-profile`, `--isolated`
  is false) but **logged into nothing**. Fine for public sites, `prototype.`/marketing pages,
  Lighthouse/perf audits, unauthenticated smoke checks. Does **not** close the Quincy local-auth
  gap on its own — to reach an authenticated page here, use the human-signed Chrome from Option A
  below ([Subagent-Orchestration.md](Subagent-Orchestration.md) §2 has the session policy).
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
