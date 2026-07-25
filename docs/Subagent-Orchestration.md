# Subagent Orchestration Guide

> Reference for how this session (the main agent, Claude) spawns and coordinates subagents on
> the Quincy Portal build. This is a **living document, not a one-time policy snapshot** —
> refine it whenever a session learns a new mechanic, hits a new failure mode, or the user
> changes the process. Two independent CLI tools do the plan/build/review loop, each spawned
> as a plain OS subprocess via `Bash`; a third, in-harness mechanism supplies one specific
> role (the final draft reviewer, §1a):
>
> - **Agy** — Google's Antigravity CLI (binary `agy`, symlink `antigravity`), model
>   `gemini-3.6-flash-high` (this account's configured default). Drafts plans, **and can
>   build too** (per user direction 2026-07-24) — a second, independent build pipeline
>   alongside Codex.
> - **Sol / Terra / Luna** — OpenAI's Codex CLI (`codex exec`, models `gpt-5.6-*`). Review
>   and build.
> - **Opus reviewer** — an in-harness Claude subagent (`Agent` tool, `model: opus`), not a CLI
>   subprocess. Read-only final-draft review only, one step before this session's own gate —
>   see §1a for exactly when to spawn it and when it's redundant to.
>
> Policy last updated 2026-07-25 per user direction (added the Opus 5 final-draft-reviewer
> role, §1a). Prior update 2026-07-24 (plan-drafting moved from the main agent to Agy; this
> doc genericized from a Codex-only guide once Agy — a non-Codex tool — joined the roster;
> Agy authorized as a second build pipeline in addition to Codex). Codex CLI mechanics
> verified live 2026-07-19; Agy CLI mechanics verified live 2026-07-24, including a real
> accept-edits build smoke test.
>
> **Agy is a separate CLI tool, not a Codex model — do not guess `gpt-5.6-agy` again.** An
> earlier draft of this doc guessed that model id, following the `gpt-5.6-sol/terra/luna`
> pattern; the account rejects it outright. Agy is
> **Google's Antigravity CLI** (https://antigravity.google/docs/cli/using), a separate
> binary on this machine literally named `agy` (`/Users/tingruilee/.local/bin/agy`;
> `antigravity` is a symlink to the same file). It is invoked the same way as Codex — a
> subprocess via `Bash` — but with its own flags and model roster. See §3a for its
> mechanics; §3 (Codex/`gpt-5.6-*`) is unchanged and still used for Sol/Terra/Luna.
>
> **When you learn something new about either tool** (a flag, a failure mode, a better
> prompt shape, a routing adjustment the user asks for), add it here in the relevant
> section rather than letting it live only in a session transcript. This doc should keep
> getting better across sessions, not get rewritten from scratch each time.

---

## 1. Roles

| Agent | CLI tool | Model | Default job | Builds? |
|---|---|---|---|---|
| **Agy** | `agy` (Antigravity, Google) | `gemini-3.6-flash-high` (account default, confirmed in `~/.gemini/antigravity-cli/settings.json`; pass `--model gemini-3.6-flash-high` explicitly to not rely on the default) | Drafts implementation plans (`--mode plan`); **also a second build pipeline** (`--mode accept-edits`) | **Yes**, since 2026-07-24 — see §3a for the required flags (`--add-dir`, no `--sandbox`) |
| **Sol** | `codex exec` (OpenAI) | `gpt-5.6-sol` | Reviews Agy's plans, then later reviews the built diff | Only when explicitly requested by the user, or for security/auth/payments/migrations and (at the user's discretion) large cross-system changes — see routing table |
| **Terra** | `codex exec` (OpenAI) | `gpt-5.6-terra` | Default builder; this account's default Codex model | Yes — default builder for normal feature/refactor work |
| **Luna** | `codex exec` (OpenAI) | `gpt-5.6-luna` | Cheap/high-volume builder | Yes — small, mechanical, strongly-tested work |
| **Opus reviewer** | `Agent` tool (in-harness Claude subagent, not a CLI subprocess) | `opus` (Claude Opus 5), high effort | **Final draft reviewer** — the last review pass before this session's own independent-verification gate (§5) | No — read-only review only, never assign it build work |

Sol/Terra/Luna run at `model_reasoning_effort=high` unless a task specifically calls for
something else; Agy runs at `--effort high` likewise. The `Agent` tool has no separate
reasoning-effort dial for Claude subagents — "high effort" for the Opus reviewer means
instructing it explicitly in the prompt to review at maximum thoroughness/rigor (see §1a).

**Agy as a builder — how to use it:** Agy is now a genuine second, independent build
pipeline (different vendor/model family from Codex), useful for running two unrelated,
non-overlapping work items in true parallel — e.g. one wave built by Terra, a different
wave simultaneously built by Agy. It is **not** a replacement for Terra/Luna and isn't yet
assigned a default row in the routing table below; until real-world use establishes a
pattern, route work to Agy the same way you'd choose Terra vs. Luna (small/mechanical →
lower stakes; normal feature → fine either way), and always still route the *review* through
Sol regardless of which pipeline built it. See §3a for the exact flags required to build
successfully — getting them wrong doesn't error, it **silently no-ops** (see the
trusted-workspace gotcha below).

### 1a. Opus 5 final-draft review — when to use it, when to skip it

**Purpose:** after Sol's diff review and fix loop are done, and before this session
independently gates the work (§5), spawn one more review pass — a fresh Claude Opus 5
subagent, reading only the final diff (not the build history), looking for anything Sol's
review and this session's own read-through might both have missed. This is a genuine second
model family's judgment on the same diff, not a rubber stamp.

**Skip this step when the main session itself is already running as Opus 5.** The point of
this role is to get a review from a *different, typically stronger* model than whatever
normally drives the session (this account's default driver is Sonnet 5). If the session
itself is currently running on Opus 5, it already **is** that reviewer — spawning a second
Opus 5 subagent to review the same session's own work adds no new judgment, just latency and
cost. In that case, the main session's own independent-verification pass (§5) already carries
the "Opus-level final look" this role exists to provide. Check which model is driving the
current session before deciding whether to spawn this step — do not spawn it reflexively on
every task regardless of driver.

This step is a **review of judgment/correctness**, not a substitute for §5's mechanical
verification (typecheck/tests/build) — do both; neither replaces the other.

---

## 2. Policy rules

1. **Plans are drafted by Agy, then must be Sol-reviewed before build starts.** This
   session assigns planning tasks to `gpt-5.6-agy` (`--sandbox read-only`,
   `model_reasoning_effort=high`) rather than drafting the implementation plan itself. The
   plan is not authoritative until `gpt-5.6-sol` (`--sandbox read-only`,
   `model_reasoning_effort=high`, fresh context) has reviewed it and the plan has been
   revised to address that review — repeat the Agy-draft → Sol-review cycle until Sol
   approves.
2. **Build work goes to Terra, Luna, or Agy — not Sol.** Assign implementation tasks to
   `gpt-5.6-terra`, `gpt-5.6-luna`, or Agy (`--mode accept-edits`, see §3a), all at high
   effort. Agy is a genuine second pipeline (independent vendor/model), most useful for
   running an unrelated work item truly in parallel alongside a Codex-built one. **Never
   assign `gpt-5.6-sol` to a build task** unless the user explicitly asks for it for that
   specific task, or the work falls in a "Sol builds" row of the routing table below. Sol
   reviews regardless of which pipeline built the diff.
3. **Opus 5 (high effort) is the final draft reviewer, one step before this session's own
   gate** — spawned via the `Agent` tool (`model: opus`), reading the final diff after Sol's
   review/fix loop is done. **Skip this step if the main session is already running as
   Opus 5** — see §1a for why. This step never builds, only reviews.
4. Deploy and commit only after this session's own independent verification passes (§5) —
   never on an agent's self-report alone.

### Reference pipeline

The full plan → build → review → fix cycle, in order:

1. **Agy** — inspect the repository and produce an implementation plan.
2. **Sol, read-only** — review that plan; send back to Agy for revision until approved.
3. **Terra** (or Luna, per routing table) — implement the approved plan and run tests.
4. **Terra** — self-check the diff against every plan item.
5. **Sol, fresh context** — review the actual diff (not the plan).
6. **Terra** — apply clearly identified fixes from the review.
7. **Sol** — final focused review for unresolved high-severity issues.
8. **Opus 5 (high effort), via `Agent` tool** — final draft review of the diff, fresh
   perspective from a different model family than whatever drove the build/review loop.
   **Skip if this session is already Opus 5** (§1a).
9. **This session** — independent verification gate (§5): re-run typecheck/tests/build
   directly, read security/correctness-critical parts of the diff personally. Only after this
   passes: deploy and commit.

### Routing table

| Work type                            | Builder                      | Reviewer          |
|---------------------------------------|-------------------------------|--------------------|
| Small, mechanical, strongly tested   | Luna                          | Terra              |
| Normal feature or refactor           | Terra                         | Sol                |
| Security, auth, payments, migrations | Sol                           | Separate Sol run   |
| Large cross-system change            | Terra or Sol                  | Sol at max effort  |
| Cheap high-volume implementation     | Luna, then escalate failures  | Terra or Sol       |

The "Sol builds" rows (security/auth/payments/migrations; large cross-system changes) are
the explicit exception referenced in rule 2 — not a default to fall back to casually.

---

## 3. CLI mechanics

`codex exec` spawns the real **Codex CLI as a subprocess via `Bash`** — it is a separate
process running on OpenAI's model, not the `Agent` tool. There is a second, distinct
mechanism in this harness for spawning a *Claude* subagent (`Agent` tool,
`subagent_type: general-purpose`). Two standing uses for it in this project:

- `model: opus` — the final-draft-reviewer role (§1a), spawned automatically as part of the
  reference pipeline (skip only per the condition in §1a), not something that needs the user
  to ask for it each time.
- `model: sonnet` — a Claude-side **builder**, used only when the user specifically asks for
  one instead of a Codex/Agy build (see the historical example in the appendix).

There is no first-class "Codex subagent" tool — Codex is invoked as a plain CLI subprocess,
with its own sandboxing and file access, and its output is read back from a file.

```bash
codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=high "..."
```

- This account's CLI **default** model (`~/.codex/config.toml`) is `gpt-5.6-terra` at
  `model_reasoning_effort=high`. Pass `-m <model>` to override for a single invocation
  (e.g. `-m gpt-5.6-sol`, `-m gpt-5.6-luna`).
- There is no dedicated `--reasoning-effort` flag — effort is set via
  `-c model_reasoning_effort=<value>`.

### Flags quick reference

| Flag | Purpose |
|---|---|
| `--sandbox workspace-write` | Implementation tasks — file writes allowed |
| `--sandbox read-only` | Review/planning tasks — no file writes possible |
| `--output-last-message <file>` | Write only the agent's final report to a clean file |
| `-m <model>` | Override the default model for one invocation |
| `-c model_reasoning_effort=high` | Set reasoning effort |
| `-c 'sandbox_workspace_write.network_access=true'` | Allow network from a workspace-write sandbox (needed for MCP calls) |

Flag that does **not** exist on `codex exec`: `--no-terminal` — that belongs to `acpx`'s
Claude-session wrapper, not the Codex CLI.

---

## 3a. Agy (Antigravity) CLI mechanics

Agy is invoked the same way as Codex — as a subprocess via `Bash`, output captured to a
file — but it is a **different binary with different flags**, not `codex exec -m
gpt-5.6-agy` (that model id does not exist; see the warning at the top of this doc).

```bash
agy --mode plan --effort high --sandbox --dangerously-skip-permissions \
  --print-timeout 10m0s -p "..." > report.md 2> run.log
```

**`--dangerously-skip-permissions` is required for any headless (`-p`) task that reads
files via shell commands (`grep`/`cat`/`find`/etc.), not optional.** Without it, the first
tool call needing a permission prompt is auto-denied (headless mode cannot prompt
interactively) and the run silently produces **empty stdout** with no error on stdout — the
only signal is in stderr: `"jetski: no output produced — a tool required the \"command\"
permission that headless mode cannot prompt for, so it was auto-denied."` Always check
stderr, not just whether the report file is empty, when an Agy run looks like it did
nothing. Combine with `--mode plan` (agent won't attempt edits) and `--sandbox` (OS-level
restrictions) to keep a planning task safely read-only despite skipping the permission
prompt — the prompt-skip is about not blocking on unanswerable interactive prompts, not
about removing the other two guardrails.

- Binary: `agy` (also reachable as `antigravity`, a symlink to the same file). Verified live
  2026-07-24.
- `-p` / `--print` / `--prompt`: run one prompt non-interactively and print the response —
  this is Agy's equivalent of `codex exec "..."`. Response goes to **stdout**, so redirect it
  to the report file directly (there is no separate `--output-last-message` flag like Codex
  has); send stderr to a separate log file.
- `--mode plan`: read/plan-only mode — Agy's equivalent of Codex's `--sandbox read-only`. Use
  this for every drafting task. `--mode accept-edits` is the equivalent of
  `--sandbox workspace-write` (only use if Agy is ever asked to build, not just plan).
- `--sandbox`: run in a sandbox with terminal restrictions enabled — include this for
  planning tasks as an extra safety layer alongside `--mode plan`.
- `--effort low|medium|high`: reasoning effort (same idea as Codex's
  `model_reasoning_effort`). Use `high` for real planning tasks.
- `--model <name>`: optional override. `agy models` lists what's on this account (as of
  2026-07-24: `gemini-3.6-flash-{high,medium,low}`, `gemini-3.5-flash-{high,medium,low}`,
  `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`). Omit to use the account's configured default, as this session did
  for its first real task — do not invent a preference for a specific underlying model
  without being asked.
- `--print-timeout <duration>` (default `5m0s`): raise this for substantial planning tasks —
  `10m0s` was used successfully for a real cross-system architecture plan.
- `agy agents` / `agy agent`: lists configured named agents (empty by default on this
  account — there is no agent literally named "Agy" inside the tool; **Agy** is this
  session's name for "whatever `agy` the CLI produces," analogous to how Sol/Terra/Luna are
  this doc's names for specific `gpt-5.6-*` models).
- Smoke-test before trusting a new invocation shape: `agy --mode plan --effort low -p
  "reply with exactly: agy reachable"` — cheap, fast, confirms the binary and flags work
  before spending a long real task on it.

### Building with Agy (`--mode accept-edits`) — verified 2026-07-24

```bash
agy --model gemini-3.6-flash-high --mode accept-edits --effort high \
  --dangerously-skip-permissions \
  --add-dir "<absolute repo root>" \
  --print-timeout 10m0s \
  -p "..." > report.md 2> run.log
```

Differences from the plan-mode invocation above, both **required**, neither optional:

1. **Do not pass `--sandbox` for a build task.** Combined with `--mode accept-edits` it
   still blocks real file writes — the CLI replies as if it succeeded ("done") but the
   file on disk is unchanged, with **no error printed anywhere** (checked both stdout and
   stderr). `--sandbox` is a planning-only safety layer (§3a above); drop it entirely once
   the task needs to actually write.
2. **Pass `--add-dir "<repo root>"` (absolute path) whenever the target directory isn't
   already a trusted workspace.** Agy's own `~/.gemini/antigravity-cli/settings.json` has a
   `trustedWorkspaces` allowlist (as of 2026-07-24: `/Users/tingruilee` and two
   `Documents/Codex/...` paths). Writes **inside** a trusted path succeed normally with just
   `--mode accept-edits --dangerously-skip-permissions`. Writes **outside** it (e.g. this
   repo, which lives on a different volume entirely) are **silently no-ops** — same "done"
   reply, zero effect, zero error — unless `--add-dir` explicitly grants that directory for
   the session. **Verified by direct test both ways**: a write to a `/tmp` scratch file
   silently failed three times running variations of the invocation (with and without
   `--sandbox`); the identical prompt against a path under `/Users/tingruilee` worked
   immediately; the identical prompt against the actual repo path with `--add-dir` added
   also worked immediately. Always verify a real Agy build actually touched disk (`git
   status` / read the file back) before trusting its self-report — this failure mode is
   silent, not a stderr message.
3. Do not add `--sandbox` "just to be safe" for a build task expecting it to merely
   restrict scope rather than block writes entirely — that's not what it does here; scope
   restriction for Agy builds comes from `--add-dir` (grant exactly the directories needed,
   nothing more), not from `--sandbox`.

As with Codex, never trust an Agy build's self-report — re-run the full verification
matrix (§5) and read the actual diff yourself before considering a build complete.

---

## 4. Spawn procedure

1. **Write a precise spec to a scratchpad file first** — never inline the whole task as a
   raw string. This keeps prompts reviewable and makes the exact spec reusable for a
   follow-up round if a fix loop is needed.

   ```
   Write(file_path=".../scratchpad/wp-x-taskname.md", content="<the full spec>")
   ```

2. **Launch as a background Bash command**, reading the spec back in via `cat`, capturing
   the agent's final report to its own file:

   ```bash
   SCRATCH=".../scratchpad"
   cd "<repo root>" && codex exec \
     --sandbox workspace-write \
     --output-last-message "$SCRATCH/wp-x-report.md" \
     "$(cat "$SCRATCH/wp-x-taskname.md")" \
     > "$SCRATCH/wp-x-run.log" 2>&1
   ```

   Run via `Bash` with `run_in_background: true` so orchestration continues in parallel; a
   task notification arrives when the process exits.

3. **Choose sandbox mode by intent, not by default:**
   - `--sandbox workspace-write` for implementation tasks (needs to edit/create files).
   - `--sandbox read-only` for **review-only or planning** tasks, so the agent structurally
     cannot "fix while reviewing."
   - Add `-c 'sandbox_workspace_write.network_access=true'` for tasks that need network
     from a workspace-write sandbox (e.g. MCP calls) — but see §6, this alone does not fix
     MCP write-approval failures.

4. **Read the report file, never the raw transcript.** `--output-last-message` writes just
   the final message to a clean file; do not read the full JSONL transcript directly — it
   can overflow context.

---

## 5. Independent verification (required before trusting any report)

Never trust an agent's self-report as ground truth. After every round, regardless of what
the report claims, re-run verification directly in this session:

```bash
npx tsc -p <workspace>/tsconfig.json      # per workspace
npx vitest run --config workers/app/vitest.config.ts
npm run build -w @quincy/web
```

This has caught real bugs a report claimed were fine (e.g. a guard comparing two values
from the same closure that could never fire). Deploy and commit only after this
independent verification passes.

---

## 6. Known failure mode: Codex + MCP write actions

Handing Codex a task that requires calling a **write** action on a remote MCP server can
fail: `codex exec` runs with `approval: never`, and some MCP write tools need a per-call
approval Codex cannot grant non-interactively. Read-only MCP calls on the same server can
work fine in the same run. When this happens, do not keep tuning the Codex invocation —
fall back to an already-authenticated CLI (e.g. `wrangler` for Cloudflare) and do the
write directly. See `docs/lessons.md` for the related MCP-tool-list staleness issue.

---

## Appendix: historical session log (2026-07-19)

Kept for provenance. Reflects one past session's execution, before the current policy
(§2) existed — read §1–§6 for what to actually do; treat this appendix as an example, not
an instruction to repeat verbatim (e.g. it used a Sonnet-5 builder for one feature by
explicit user request, which predates the Terra/Luna-build, Sol-reviews default).

For one feature (lightbox markup editing), the user explicitly asked for a three-stage
pipeline: a Sonnet-5 builder, a Codex reviewer, and the session itself as final gate,
looping until clean:

1. **Sonnet 5 builds** (via `Agent` tool, `model: sonnet`, high effort), against a detailed
   spec, with its own verification bar (typecheck, tests, build) before reporting.
2. **Codex reviews**, read-only, against a written checklist (per-item severity, file:line
   evidence, explicit APPROVE / REQUEST-CHANGES verdict) — same `codex exec --sandbox
   read-only` pattern, pointed at the live `git diff` instead of a spec.
3. **The session re-verifies independently** (re-running the test suite, personally
   reading security-sensitive parts of the diff — auth checks, author-only guards).
4. If Codex's verdict was REQUEST-CHANGES, findings go back to the **same** builder agent
   (via `SendMessage` to its agent id, resuming with full context) with precise per-finding
   fix instructions — not a vague "fix the review comments."
5. Repeat steps 2–4 until Codex approves AND independent verification passes. In this
   instance that took three review rounds; the loop caught a genuine silent-data-loss bug
   before it reached production.
6. Only then: deploy + commit.

Two subagent mechanisms were distinguished in that session:

| Mechanism | What it is | Used for |
|---|---|---|
| `Bash` → `codex exec ...` | The real Codex CLI as a subprocess, on OpenAI's model | Every Codex subagent that session — implementation waves and independent review |
| `Agent` tool, `subagent_type: general-purpose`, `model: sonnet` | A Claude subagent inside this harness | The one Sonnet-5 implementation task (WP-M) the user explicitly asked to route that way |
