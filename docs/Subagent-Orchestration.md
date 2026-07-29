# Subagent Orchestration

How this session spawns and coordinates subagents on the Quincy Portal build.

**Living document.** When a session learns a new mechanic, hits a new failure mode, or the
user changes the process, write it here (or in the CLI reference this points at) rather than
leaving it in a transcript. Section numbers §1–§6 are stable — other docs link to them.

Verified live: Codex mechanics 2026-07-19, Agy mechanics 2026-07-24 (including a real
accept-edits build test — kept for reference even though Agy no longer builds by default, see
§1). Policy changed 2026-07-26: Terra replaces Sol as the default reviewer, Sonnet 5
(this session) drafts the first plan instead of Agy, and Agy's pipeline role is reduced to ad
hoc groundwork. Policy changed again 2026-07-29: Terra (not Sonnet 5) now drafts the first plan,
and plan approval became a two-tier process — Terra reviews its own draft first (capped at 2
rounds), then a separate Opus tier reviews the result, with its own capped Terra-revert budget
before Opus takes the plan over directly (see §2 policy 1). Policy changed again 2026-07-29:
diagnostic and testing tasks can be routed straight to Terra or Luna outside the full pipeline
(split by difficulty), and both have their own local Chrome browser and OpenCLI skill access on
this machine (see §2 policy 8).

---

## 1. Roles

| Agent | Spawned via | Model | Job | Builds? |
|---|---|---|---|---|
| **Sonnet 5** | this session, directly — no subprocess | Claude Sonnet 5 | Orchestrates the full pipeline (spawns and sequences Terra/Opus, runs the §5 gate); may draft/build a task itself instead of delegating | Yes, at this session's discretion for tasks too small to be worth handing off |
| **Terra** | `codex exec` — [§3](subagents/codex-cli.md) | `gpt-5.6-terra`, high effort | Drafts the first plan and reviews it (fresh context, capped at 2 rounds — see §2 policy 1); default builder; also reviews the diff; harder diagnostic/testing tasks | Yes |
| **Luna** | `codex exec` | `gpt-5.6-luna` | Cheap/high-volume builder; straightforward diagnostic/testing tasks | Yes |
| **Agy** | `agy` CLI subprocess — [§3a](subagents/agy-cli.md) | `gemini-3.6-flash-high` | Ad hoc simple groundwork only (quick investigation, one-off scaffolding) — no longer plans or builds pipeline work | Only for that groundwork, never a pipeline step |
| **Opus reviewer** | `Agent` tool, `model: opus` | Claude Opus 5 | Reviews the plan (new tier, §2 policy 1) and the final diff before the §5 gate | No code, ever — narrow plan-document exception below |
| **Sol** | `codex exec` | `gpt-5.6-sol` | No default role — spawn only if the user explicitly asks for it on a specific task | N/A |

Codex agents run at `-c model_reasoning_effort=high`, Agy at `--effort high`, unless a task
calls for otherwise. The `Agent` tool has no effort dial — ask for maximum rigor in the prompt.

**Codex agents (Terra/Luna) have their own local Chrome browser access and OpenCLI skills on
this machine** — separate from this session's own Claude Browser tools. A spawned `codex exec`
process can drive the local Chrome browser directly and call the `opencli` skill family
(`opencli-browser`, `opencli-usage`, etc.) for diagnostics and testing: live-site checks,
browser-based reproduction of a bug, automated UI testing, or anything else that needs an actual
browser rather than just reading code. State this explicitly in a diagnostic/testing task's
prompt when it would help — don't assume Codex will reach for it unprompted.

**Diagnostic and testing tasks don't need the full plan→review pipeline.** Investigation,
bug reproduction, or writing/running tests outside a full build can go straight to Terra or Luna
via `codex exec`, chosen by difficulty — Luna for straightforward checks, Terra for harder
investigative reasoning or thorough test-writing. Verify their findings directly in this session
(§5) rather than routing them through a separate reviewer pass, the same way Agy's ad hoc
groundwork is handled.

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

**Opus's plan-tier review is a separate role from its diff review.** After Terra's own
draft→review loop (§2 policy 1) produces a plan — whether Terra approved it within 2 rounds or
the cap was hit first — a fresh Opus subagent reviews the plan document itself (not code, not a
diff). If Opus approves, the plan is done. If Opus requests changes, revert to a *fresh* Terra
spawn with Opus's findings to revise the plan; this Opus→Terra revert is capped at 2 times. If
Opus still isn't satisfied after those 2 reverts, Opus edits the plan document directly itself,
then a second, fresh Opus invocation self-reviews and approves that edit — this is the only place
in the pipeline where a review agent is permitted to write anything, and it's scoped strictly to
the plan document, never implementation code.

**Opus final-draft review — skip it when this session is itself running as Opus 5.** The role
exists to get a stronger, different model's eyes on the final diff than whatever normally
drives the session (default driver: Sonnet 5). When the driver *is* Opus 5, the §5 gate already
carries that judgment, and a second Opus subagent reviewing its own session's work buys latency
and cost, not insight. Check the driver before spawning; this is a review of judgment and
correctness, never a substitute for §5's mechanical verification.

---

## 2. Policy

1. **Terra (high effort) drafts the first plan.** A separate, fresh Terra (high effort) reviews
   it; loop draft → review → revise, capped at a **maximum of 2 Terra review rounds** — don't
   loop indefinitely waiting for Terra's approval. Whatever plan results (Terra-approved within
   the cap, or not) then goes to a fresh **Opus** subagent for a second, independent review tier:
   Opus approves it, or requests changes and the plan reverts to a fresh Terra spawn for
   revision — capped at a **maximum of 2 such Opus→Terra reverts**. After that cap, Opus edits
   the plan document itself, then a fresh Opus self-review approves it. Only after this full
   sequence resolves does any build start.
2. **Build tasks go to Terra or Luna — or Sonnet 5 builds directly** when a task is small and
   mechanical enough that delegating it isn't worth the overhead. Use judgment; don't delegate
   reflexively, and don't inline something substantial just to dodge the overhead.
3. **Terra also reviews the diff**, in a fresh invocation separate from whichever run built it
   — see the §1 caveat about Terra reviewing its own kind of work.
4. **Reviewers are read-only**, so they cannot quietly fix what they're reviewing: Codex
   review runs use `--sandbox read-only`, always in fresh context. The one deliberate exception
   is Opus's plan-tier terminal case (policy 1): after exhausting its Terra-revert budget, Opus
   may edit the plan document itself, then self-reviews that edit in a fresh invocation before
   approving — scoped strictly to the plan document, never implementation code.
5. **Sol has no default role.** Spawn it only on explicit user request for a specific task.
6. **Agy drafts nothing and builds nothing in the pipeline.** It's still fine for ad hoc,
   low-stakes groundwork outside the formal pipeline — see §1.
7. **Nothing deploys or commits on an agent's self-report** — only after the §5 gate passes.
8. **Diagnostic and testing tasks can bypass the full pipeline.** Assign them directly to Terra
   or Luna via `codex exec`, split by difficulty (Luna for simple checks, Terra for harder
   investigation or testing) — see §1. Codex agents have their own local Chrome browser and
   OpenCLI skills available for this; mention them in the task prompt when relevant.

### Pipeline

Terra drafts a plan → a fresh Terra reviews it (loop capped at 2 rounds) → a fresh Opus reviews
the resulting plan, either approving it or reverting to a fresh Terra spawn for revision (capped
at 2 reverts, after which Opus edits the plan itself and self-approves) → Terra or Luna
implements and runs tests, or Sonnet 5 builds directly for a small task → builder self-checks the
diff against every plan item → **Terra reviews the diff itself, in a fresh separate invocation,
not the plan** → builder applies clearly identified fixes → Terra does a final focused pass for
unresolved high-severity findings → Opus final-draft review of the diff (skip per §1) → **§5 gate
in this session** → deploy and commit.

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
| Diagnostic / testing only, no build | Luna (simple) or Terra (harder) | Verify directly in this session (§5) — no separate reviewer pass |

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
Opus's two review touchpoints (the plan-tier review and the final-draft diff review — both §1,
§2 policy 1), and `model: sonnet` for a separate, isolated Claude builder — distinct from this
session building small tasks directly (§1) — used only when the user specifically asks for one
instead of a Codex build.

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
