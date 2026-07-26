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

## Passing a large prompt safely — `-p` has no stdin equivalent

Agy's `-p` takes a positional argument only; unlike `codex exec`, there is no stdin mode to fall
back to (see [codex-cli.md](codex-cli.md)'s stdin-hang failure mode for why that matters there).
For a large prompt, `-p "$(cat "$SCRATCH/prompt.md")"` is safe **as long as the entire argument
is that one substitution and nothing else** — command-substitution output is not re-scanned for
further `$`/backtick expansion, so backticks or `${...}` inside the file pass through literally
(verified live: a file containing `` `writeAutoHdrFinal()` `` and `${assetId}` came through
unexpanded). The danger is mixing hand-typed prose into the *same* double-quoted argument as the
substitution — e.g. `"$(cat a)... some ${literal} text ...$(cat b)"` — since that hand-typed
`${literal}` is parsed as a real expansion by the outer quotes, not as inert text. Keep each `-p`
argument to a single clean substitution (concatenate multiple source files into one scratchpad
file first, then `cat` that one file) rather than assembling the prompt inline.
