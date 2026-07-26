# Subagent Orchestration

How this session spawns and coordinates subagents on the Quincy Portal build.

**Living document.** When a session learns a new mechanic, hits a new failure mode, or the
user changes the process, write it here (or in the CLI reference this points at) rather than
leaving it in a transcript. Section numbers §1–§6 are stable — other docs link to them.

Verified live: Codex mechanics 2026-07-19, Agy mechanics 2026-07-24 (including a real
accept-edits build test — kept for reference even though Agy no longer builds by default, see
§1). Policy last changed 2026-07-26: Terra replaces Sol as the default reviewer, Sonnet 5
(this session) drafts the first plan instead of Agy, and Agy's pipeline role is reduced to ad
hoc groundwork.

---

## 1. Roles

| Agent | Spawned via | Model | Job | Builds? |
|---|---|---|---|---|
| **Sonnet 5** | this session, directly — no subprocess | Claude Sonnet 5 | Drafts the first implementation plan; may build a task itself instead of delegating | Yes, at this session's discretion for tasks too small to be worth handing off |
| **Terra** | `codex exec` — [§3](subagents/codex-cli.md) | `gpt-5.6-terra`, high effort | Default builder; also reviews the plan and the diff (replacing Sol) | Yes |
| **Luna** | `codex exec` | `gpt-5.6-luna` | Cheap/high-volume builder | Yes |
| **Agy** | `agy` CLI subprocess — [§3a](subagents/agy-cli.md) | `gemini-3.6-flash-high` | Ad hoc simple groundwork only (quick investigation, one-off scaffolding) — no longer plans or builds pipeline work | Only for that groundwork, never a pipeline step |
| **Opus reviewer** | `Agent` tool, `model: opus` | Claude Opus 5 | Final draft review, one step before the §5 gate | No — read-only, never assign it build work |
| **Sol** | `codex exec` | `gpt-5.6-sol` | No default role — spawn only if the user explicitly asks for it on a specific task | N/A |

Codex agents run at `-c model_reasoning_effort=high`, Agy at `--effort high`, unless a task
calls for otherwise. The `Agent` tool has no effort dial — ask for maximum rigor in the prompt.

**"Sonnet 5" here means this orchestrating session acting directly** — reading and writing
files with its own tools, not spawning a subagent. That's distinct from the `Agent` tool's
`model: sonnet` option (§3), which launches a *separate* Sonnet subagent and remains something
used only when the user specifically asks for an isolated Claude builder.

**Terra now reviews work it may have built.** It's both the default builder and the default
reviewer, so always run the review as a fresh, separate invocation with no shared context from
the build — the same discipline Sol's reviews used. This is a thinner check than a genuinely
different model catching what the builder missed; it's the accepted tradeoff for now. Spawn
Sol (see above) when a task is high-stakes enough to want an independent model's eyes.

**Agy is Google's Antigravity CLI — a separate binary, not a Codex model.** There is no
`gpt-5.6-agy`; the account rejects that id outright, and an earlier draft of this doc invented
it by pattern-matching Sol/Terra/Luna. As of 2026-07-26 Agy is no longer part of the plan →
build → review pipeline, but its CLI mechanics ([subagents/agy-cli.md](subagents/agy-cli.md))
are kept in full — if Agy moves to a more capable underlying model later, its pipeline role
may come back.

**Opus final-draft review — skip it when this session is itself running as Opus 5.** The role
exists to get a stronger, different model's eyes on the final diff than whatever normally
drives the session (default driver: Sonnet 5). When the driver *is* Opus 5, the §5 gate already
carries that judgment, and a second Opus subagent reviewing its own session's work buys latency
and cost, not insight. Check the driver before spawning; this is a review of judgment and
correctness, never a substitute for §5's mechanical verification.

---

## 2. Policy

1. **Sonnet 5 (this session) drafts the plan; Terra (high effort) must approve it before any
   build starts.** Loop draft → review → revise until Terra approves, in fresh context each
   time.
2. **Build tasks go to Terra or Luna — or Sonnet 5 builds directly** when a task is small and
   mechanical enough that delegating it isn't worth the overhead. Use judgment; don't delegate
   reflexively, and don't inline something substantial just to dodge the overhead.
3. **Terra also reviews the diff**, in a fresh invocation separate from whichever run built it
   — see the §1 caveat about Terra reviewing its own kind of work.
4. **Reviewers are read-only**, so they cannot quietly fix what they're reviewing: Codex
   review runs use `--sandbox read-only`, always in fresh context.
5. **Sol has no default role.** Spawn it only on explicit user request for a specific task.
6. **Agy drafts nothing and builds nothing in the pipeline.** It's still fine for ad hoc,
   low-stakes groundwork outside the formal pipeline — see §1.
7. **Nothing deploys or commits on an agent's self-report** — only after the §5 gate passes.

### Pipeline

Sonnet 5 (this session) drafts a plan → Terra reviews it in fresh context (loop until
approved) → Terra or Luna implements and runs tests, or Sonnet 5 builds directly for a small
task → builder self-checks the diff against every plan item → **Terra reviews the diff itself,
in a fresh separate invocation, not the plan** → builder applies clearly identified fixes →
Terra does a final focused pass for unresolved high-severity findings → Opus final-draft review
(skip per §1) → **§5 gate in this session** → deploy and commit.

Fix loops go back to the *same* agent with per-finding instructions — resume it rather than
starting cold, and never hand back a vague "address the review comments."

### Routing table

| Work type | Builder | Reviewer |
|---|---|---|
| Small, mechanical, strongly tested | Luna | Terra |
| Too small to be worth delegating | Sonnet 5 (this session) | Terra |
| Normal feature or refactor | Terra | Terra, fresh context |
| Security, auth, payments, migrations | Terra, max effort | Terra, separate run, max effort |
| Large cross-system change | Terra | Terra, max effort |
| Cheap high-volume implementation | Luna, escalate failures | Terra |

Sol has no row — it's the explicit-request exception from §1, not a default. Route Agy work
only as ad hoc groundwork outside this table, never as a plan or build step.

---

## 3. CLI mechanics

Codex and Agy are **plain OS subprocesses spawned via `Bash`**, not the `Agent` tool — each
with its own flags, sandboxing, and file access, with output read back from a file. There is
no first-class "Codex subagent" tool.

- **Codex (Terra/Luna, and Sol on request): [subagents/codex-cli.md](subagents/codex-cli.md)**
  — invocation, flag reference, and the MCP write-approval failure mode (§6).
- **§3a — Agy (Antigravity): [subagents/agy-cli.md](subagents/agy-cli.md)** — invocation, plan
  vs. build flags, and two failure modes that produce a cheerful "done" with **zero effect and
  zero error output**. Read it before any Agy groundwork task.

The `Agent` tool spawns *Claude* subagents and has two standing uses here: `model: opus` for
the final-draft reviewer (§1), and `model: sonnet` for a separate, isolated Claude builder —
distinct from this session drafting plans or building small tasks directly (§1) — used only
when the user specifically asks for one instead of a Codex build.

---

## 4. Spawn procedure

Applies to Codex/Agy subprocess spawns and to a separate `Agent`-tool Claude subagent. It does
**not** apply when this session drafts a plan or builds a small task directly (§1) — that's
done inline with the session's own tools, no subprocess involved.

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
- If an Agy groundwork task was supposed to touch disk, confirm it actually did (`git status`,
  read the file back) before believing it — see §3a.

Only after this passes: deploy and commit. This gate has caught real bugs reported as fine —
e.g. a guard comparing two values from the same closure, which could never fire.

---

## 6. Known failure modes

- **Codex + MCP write actions.** `codex exec` runs with `approval: never`, and some MCP write
  tools need a per-call approval it cannot grant non-interactively — while read-only calls to
  the same server succeed in the same run. Don't keep tuning the invocation; fall back to an
  authenticated CLI (`wrangler` for Cloudflare) and do the write directly. See `lessons.md`
  for the related MCP tool-list staleness issue.
- **Agy silent no-ops.** Two separate misconfigurations make an Agy write task report success
  while changing nothing on disk. Both are in [subagents/agy-cli.md](subagents/agy-cli.md) —
  read it rather than debugging from scratch.
