# Subagent Orchestration

How this session spawns and coordinates subagents on the Quincy Portal build.

**Living document.** When a session learns a new mechanic, hits a new failure mode, or the
user changes the process, write it here (or in the CLI reference this points at) rather than
leaving it in a transcript. Section numbers §1–§6 are stable — other docs link to them.

Verified live: Codex mechanics 2026-07-19, Agy mechanics 2026-07-24 (including a real
accept-edits build test). Policy last changed 2026-07-25 (Opus final-draft reviewer).

---

## 1. Roles

| Agent | Spawned via | Model | Job | Builds? |
|---|---|---|---|---|
| **Agy** | `agy` CLI subprocess — [§3a](subagents/agy-cli.md) | `gemini-3.6-flash-high` | Drafts implementation plans; second build pipeline | Yes |
| **Sol** | `codex exec` — [§3](subagents/codex-cli.md) | `gpt-5.6-sol` | Reviews Agy's plan, then reviews the built diff | Only per the routing table, or on explicit request |
| **Terra** | `codex exec` | `gpt-5.6-terra` | Default builder | Yes |
| **Luna** | `codex exec` | `gpt-5.6-luna` | Cheap/high-volume builder | Yes |
| **Opus reviewer** | `Agent` tool, `model: opus` | Claude Opus 5 | Final draft review, one step before the §5 gate | **No — read-only, never assign it build work** |

Codex agents run at `-c model_reasoning_effort=high`, Agy at `--effort high`, unless a task
calls for otherwise. The `Agent` tool has no effort dial — ask for maximum rigor in the prompt.

**Agy is Google's Antigravity CLI — a separate binary, not a Codex model.** There is no
`gpt-5.6-agy`; the account rejects that id outright, and an earlier draft of this doc invented
it by pattern-matching Sol/Terra/Luna. It takes its own flags (`--mode plan` where Codex takes
`--sandbox read-only`) and its own model roster.

Agy builds are a genuinely independent second pipeline — different vendor and model family —
so their real value is running an unrelated work item in true parallel with a Codex build, not
substituting for Terra/Luna. Whichever pipeline builds, Sol still reviews.

**Opus final-draft review — skip it when this session is itself running as Opus 5.** The role
exists to get a stronger, different model's eyes on the final diff than whatever normally
drives the session (default driver: Sonnet 5). When the driver *is* Opus 5, the §5 gate already
carries that judgment, and a second Opus subagent reviewing its own session's work buys latency
and cost, not insight. Check the driver before spawning; this is a review of judgment and
correctness, never a substitute for §5's mechanical verification.

---

## 2. Policy

1. **Agy drafts plans; Sol must approve before any build starts.** Loop draft → review →
   revise until Sol approves. This session doesn't draft the plan itself.
2. **Sol does not build.** Builds go to Terra, Luna, or Agy. The only exceptions are the
   "Sol builds" rows of the routing table and an explicit per-task request from the user.
3. **Reviewers are read-only**, so they cannot quietly fix what they're reviewing: Codex
   reviews use `--sandbox read-only`, Agy uses `--mode plan`, always in fresh context.
4. **Nothing deploys or commits on an agent's self-report** — only after the §5 gate passes.

### Pipeline

Agy plans → Sol reviews the plan (loop until approved) → Terra/Luna/Agy implements and runs
tests → builder self-checks the diff against every plan item → **Sol reviews the diff itself,
in fresh context, not the plan** → builder applies clearly identified fixes → Sol does a final
focused pass for unresolved high-severity findings → Opus final-draft review (skip per §1) →
**§5 gate in this session** → deploy and commit.

Fix loops go back to the *same* agent with per-finding instructions — resume it rather than
starting cold, and never hand back a vague "address the review comments."

### Routing table

| Work type | Builder | Reviewer |
|---|---|---|
| Small, mechanical, strongly tested | Luna | Terra |
| Normal feature or refactor | Terra | Sol |
| Security, auth, payments, migrations | Sol | Separate Sol run |
| Large cross-system change | Terra or Sol | Sol at max effort |
| Cheap high-volume implementation | Luna, escalate failures | Terra or Sol |

Route Agy work by the same judgment used to pick Terra vs. Luna; it has no default row yet.

---

## 3. CLI mechanics

Codex and Agy are **plain OS subprocesses spawned via `Bash`**, not the `Agent` tool — each
with its own flags, sandboxing, and file access, with output read back from a file. There is
no first-class "Codex subagent" tool.

- **Codex (Sol/Terra/Luna): [subagents/codex-cli.md](subagents/codex-cli.md)** — invocation,
  flag reference, and the MCP write-approval failure mode (§6).
- **§3a — Agy (Antigravity): [subagents/agy-cli.md](subagents/agy-cli.md)** — invocation, plan
  vs. build flags, and two failure modes that produce a cheerful "done" with **zero effect and
  zero error output**. Read it before any Agy run.

The `Agent` tool spawns *Claude* subagents and has two standing uses here: `model: opus` for
the final-draft reviewer (§1), and `model: sonnet` for a Claude-side builder only when the user
specifically asks for one instead of a Codex/Agy build.

---

## 4. Spawn procedure

1. **Write the spec to a scratchpad file first** — never inline a whole task as a raw string.
   Keeps prompts reviewable and makes the spec reusable when a fix loop needs a second round.
2. **Launch in the background** (`Bash` with `run_in_background: true`), reading the spec back
   with `cat` and capturing the final report to its own file, so orchestration continues while
   the agent works and a notification arrives on exit.
3. **Read the report file, not the raw transcript** — Codex's `--output-last-message` exists
   for exactly this; the full JSONL transcript can overflow context.
4. **Choose sandbox mode by intent** — write access only for implementation tasks. Per-tool
   flags are in the §3 references.

---

## 5. The gate — independent verification

An agent's self-report is never ground truth. After every round, regardless of what the report
claims, verify in this session directly:

- Re-run the **full verify sequence in `CLAUDE.md` ("Verify before committing")** — typecheck,
  build, and both test suites including the one the root script skips.
- **Read the security- and correctness-critical parts of the diff yourself** — auth checks,
  author-only guards, anything touching money, migrations, or deletion.
- For an Agy build, confirm it **actually touched disk** (`git status`, read the file back)
  before believing it built anything at all — see §3a.

Only after this passes: deploy and commit. This gate has caught real bugs reported as fine —
e.g. a guard comparing two values from the same closure, which could never fire.

---

## 6. Known failure modes

- **Codex + MCP write actions.** `codex exec` runs with `approval: never`, and some MCP write
  tools need a per-call approval it cannot grant non-interactively — while read-only calls to
  the same server succeed in the same run. Don't keep tuning the invocation; fall back to an
  authenticated CLI (`wrangler` for Cloudflare) and do the write directly. See `lessons.md`
  for the related MCP tool-list staleness issue.
- **Agy silent no-ops.** Two separate misconfigurations make an Agy build report success while
  changing nothing on disk. Both are in [subagents/agy-cli.md](subagents/agy-cli.md) — read it
  rather than debugging from scratch.
