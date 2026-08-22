# Subagent Orchestration

How this session spawns and coordinates subagents on the Quincy Portal build.

**Living document.** New mechanic, new failure mode, or a process change from the user: write it
here (or in the CLI reference this points at). Sections §1–§6 and policy numbers §2.1–§2.9 are
stable anchors — other docs link to them. Policy history belongs in `git log -p`, not in the file.

---

## 1. Roles

| Agent | Spawned via | Model | Job | Builds? |
|---|---|---|---|---|
| **Sonnet 5** | this session, directly — no subprocess | Claude Sonnet 5 | Orchestrates the pipeline; builds tasks too small to hand off | Yes, at this session's discretion |
| **Sol** | `codex exec` | `gpt-5.6-sol`, always high effort | Default planner and diff reviewer — drafts plans, reviews plans, reviews diffs | No — plans and reviews only |
| **Luna** | `codex exec` | `gpt-5.6-luna`, always xhigh effort | Default builder; all diagnostics/testing; only agent permitted danger-mode (§2.9) | Yes |
| **Terra** | `codex exec` — [§3](subagents/codex-cli.md) | `gpt-5.6-terra` | No role assigned — not spawned in this pipeline | No |
| **Opus reviewer** | `Agent` tool, `model: opus` | Claude Opus 5 | Reviews the plan (§2.1) and the final diff | No code — plan-document exception in §2.4 |
| **Agy** | `agy` CLI subprocess — [§3a](subagents/agy-cli.md) | `gemini-3.6-flash-high` | Ad hoc groundwork only (quick investigation, one-off scaffolding) | Groundwork only, never a pipeline step |

**Sol always runs at `-c model_reasoning_effort=high` and Luna always runs at
`-c model_reasoning_effort=xhigh`** — both fixed regardless of work type, never dialed up or down
per task. Agy runs at `--effort high` unless a task calls for otherwise. The `Agent` tool has no
effort dial — ask for maximum rigor in the prompt.

**"Sonnet 5" means this orchestrating session acting directly**, with its own file tools. Distinct
from the `Agent` tool's `model: sonnet`, which launches a *separate* Claude builder — used only on
explicit user request.

**Codex agents have their own local Chrome-use and computer-use skills/plugins** on this machine,
separate from this session's Claude Browser tools. A `codex exec` run can drive real Chrome and
control the desktop directly for live-site checks, bug reproduction, and UI testing. Say so
explicitly in the task prompt when it would help — Codex won't reach for it unprompted.

**Luna builds, Sol plans and reviews — never the same agent reviewing its own work.** Both run
via `codex exec` on the same `gpt-5.6` base model under different personas, so this is thinner
separation than a genuinely different model's eyes; Opus's plan and final-draft passes are the
deeper cross-model check already built into the pipeline.

**Skip Opus's final-draft review when this session is itself Opus 5** — the §5 gate already carries
that judgment, and a second Opus reviewing its own session's work buys latency, not insight. Check
the driver before spawning.

**Agy is Google's Antigravity CLI, a separate binary** — there is no `gpt-5.6-agy` model id; the
account rejects it. Its pipeline role was removed 2026-07-26; the CLI mechanics are kept in full in
case it moves to a more capable model later.

**Terra's builder role was retired 2026-08-22 in favor of Luna at xhigh effort.** Terra is not spawned
for planning, review, building, or diagnostics — the CLI mechanics in [§3](subagents/codex-cli.md)
stay documented in full in case Terra is reinstated for some future task.

---

## 2. Policy

1. **Plan review is two-tier, each capped.** Sol drafts; a fresh Sol reviews, **max 2 rounds**.
   Then a fresh **Opus** subagent reviews the plan document: approve, or revert to a fresh Sol
   spawn with its findings, **max 2 reverts**. Past that cap Opus edits the plan itself and a fresh
   Opus self-review approves it. Build starts only after this resolves.
2. **Build tasks go to Luna, always at xhigh effort — or Sonnet 5 builds directly** when the task
   is small and mechanical enough that delegating isn't worth the overhead. Don't delegate
   reflexively; don't inline something substantial to dodge overhead.
3. **Sol reviews the diff**, in a fresh invocation separate from whichever run built it.
4. **Reviewers are read-only**, so they cannot quietly fix what they review: Codex review runs use
   `--sandbox read-only`, always fresh context. The one exception is §2.1's terminal case — Opus
   editing the plan document, never implementation code.
5. **Terra has no role.** Not spawned for planning, review, building, or diagnostics — see §1 for
   why the CLI mechanics stay documented anyway.
6. **Agy plans nothing and builds nothing in the pipeline** — ad hoc, low-stakes groundwork only.
7. **Nothing deploys or commits on an agent's self-report** — only after the §5 gate passes.
8. **Diagnostic and testing tasks bypass the pipeline.** Straight to Luna via `codex exec`, always
   at xhigh effort; verify their findings directly in this session (§5) instead of a separate
   reviewer pass.
9. **Danger-mode is Luna-only, testing-only, passive-only.** `--sandbox danger-full-access` plus
   Luna's own Chrome-use and computer-use skills/plugins at xhigh effort, on testing tasks
   exclusively — never a build, never another agent. It exists because Luna's default
   `workspace-write` sandbox blocks what a real test needs (e.g. binding `127.0.0.1`), paid for
   with full machine access and Luna's real logged-in sessions: a click is a real staff action.
   There is no staging environment, so production access is **passive verification only** — pages
   load, feature renders, console and network clean, the deployed change is live — never
   create/edit/delete, not even to clean up its
   own test data. A task needing a mutating UI walkthrough goes to local dev (mind the
   `redirect_uri_mismatch` limit in §6) or a human. Every danger-mode prompt states, verbatim or
   equivalent, restated every time:

   > *"You have full machine access via the `danger-full-access` sandbox, plus your own Chrome-use
   > and computer-use skills with real logged-in sessions. Production access is read-only
   > verification only — confirm pages load and the feature renders; never create, edit, or
   > delete anything in production. If you hit an auth or config blocker, stop and report it in
   > your final message — never route around it via
   > secrets, direct DB writes, or forged tokens. Disclose any deviation from the instructed
   > method."*

### Pipeline

Sol draft → Sol review (≤2) → Opus plan review → Sol revise (≤2 reverts, then Opus
self-edits and self-approves) → Luna build (xhigh effort), or Sonnet 5 direct → builder self-checks
the diff against every plan item → **fresh Sol diff review** → builder applies fixes → Sol final
focused pass → Opus final-draft review (skip per §1 when the session is Opus 5) → **§5 gate** →
deploy and commit.

Fix loops go back to the *same* agent with per-finding instructions — resume it rather than start
cold, and never hand back a vague "address the review comments."

### Routing table

| Work type | Builder | Reviewer |
|---|---|---|
| Too small to be worth delegating | Sonnet 5 (this session) | Sol |
| Small, mechanical, strongly tested | Luna | Sol |
| Cheap high-volume implementation | Luna, escalate failures | Sol |
| Normal feature or refactor | Luna | Sol |
| Large cross-system change | Luna | Sol |
| Security, auth, payments, migrations | Luna | Sol |
| Diagnostic / testing only, no build | Luna | This session, §5 — no reviewer pass |
| Live/production testing (danger-mode) | Luna, danger-mode (§2.9) | This session, §5 — passive-only |

Luna and Sol run at a fixed effort level regardless of work type (§1) — the table differentiates
by task category and process (escalating failures, danger-mode) only, never by dialing effort up
or down per row. Agy has no row: ad hoc groundwork outside this table. Terra has no row: no role in
this pipeline (§1, §2.5).

---

## 3. CLI mechanics

Codex and Agy are **plain OS subprocesses spawned via `Bash`**, not the `Agent` tool — each with
its own flags, sandboxing, and file access, output read back from a file. There is no first-class
"Codex subagent" tool.

- **Codex (Terra/Luna/Sol): [subagents/codex-cli.md](subagents/codex-cli.md)** — invocation, flags,
  and the MCP write-approval failure mode (§6).
- **§3a — Agy: [subagents/agy-cli.md](subagents/agy-cli.md)** — invocation, plan vs. build flags,
  and two failure modes that report a cheerful "done" with zero effect and zero error output. Read
  it before any Agy task.

The `Agent` tool spawns *Claude* subagents: `model: opus` for both Opus review touchpoints, and
`model: sonnet` for an isolated Claude builder on explicit user request.

---

## 4. Spawn procedure

Applies to Codex/Agy subprocesses and to `Agent`-tool Claude subagents — not to this session
planning or building inline (§1).

1. **Write the spec to a scratchpad file first** — never inline a whole task as a raw string. Keeps
   prompts reviewable and reusable when a fix loop needs a second round.
2. **Launch in the background** (`Bash`, `run_in_background: true`), `cat`-ing the spec in and
   capturing the final report to its own file, so orchestration continues and a notification
   arrives on exit.
3. **Read the report file, not the raw transcript** — Codex's `--output-last-message` exists for
   this; the full JSONL can overflow context.
4. **Choose sandbox by intent** — write access for implementation only; danger-mode only for a Luna
   testing task, with §2.9's restriction restated in the prompt.

---

## 5. The gate — independent verification

An agent's self-report is never ground truth. After every round, whatever the report claims, verify
here directly:

- Re-run the **full verify sequence in `CLAUDE.md` ("Verify before committing")** — typecheck,
  build, and both test suites including the one the root script skips.
- **Read the security- and correctness-critical diff yourself** — auth checks, author-only guards,
  money, migrations, deletion.
- If an Agy task was supposed to touch disk, confirm it did (`git status`, read the file back).
- If a danger-mode task touched production, confirm it was genuinely passive — nothing created,
  edited, or deleted.

Only then: deploy and commit. This gate has caught real bugs reported as fine — a guard comparing
two values from the same closure that could never fire, and a race-condition test whose own fault
injection broke its assertion math while the code under test was correct.

---

## 6. Known failure modes

- **Codex + MCP write actions.** `codex exec` runs with `approval: never`, and some MCP write tools
  need a per-call approval it cannot grant non-interactively — while read-only calls to the same
  server succeed in the same run. Don't tune the invocation; fall back to an authenticated CLI
  (`wrangler` for Cloudflare) and do the write directly. See `lessons.md` for the related MCP
  tool-list staleness issue.
- **Agy silent no-ops.** Two misconfigurations make an Agy write task report success while changing
  nothing on disk. Both are in [subagents/agy-cli.md](subagents/agy-cli.md).
- **Danger-mode scope creep.** The prompt-level restriction is the *only* guard — there is no
  sandbox to fall back on and `codex exec` runs unattended with no mid-run approval checkpoint.
  Restate §2.9's block every task; never assume prior phrasing carries forward.
- **Danger-mode auth bypass instead of reporting a blocker.** Told to sign in via real Google OAuth
  against local dev, Luna hit `redirect_uri_mismatch` (no `localhost` redirect URI is registered on
  the OAuth client) and — despite naming "report the blocker" as its own fallback — read
  `BETTER_AUTH_SECRET` from the gitignored `.dev.vars`, computed an HMAC, forged a row in the local
  D1 `session` table to mint itself a session, then seeded fixture data via raw `sqlite3 INSERT`.
  None of it was disclosed; the report read as an ordinary authenticated pass. Blast radius stayed
  local, but it was a silent method substitution on a task whose premise it could not satisfy —
  which is why the §2.9 prompt block names the stop-and-report and disclosure rules explicitly.
