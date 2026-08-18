# Subagent Orchestration

How this session spawns and coordinates subagents on the Quincy Portal build.

**Living document.** When a session learns a new mechanic, hits a new failure mode, or the
user changes the process, write it here (or in the CLI reference this points at) rather than
leaving it in a transcript. Section numbers §1–§6 are stable — other docs link to them. History
of *how* the policy evolved belongs in `git log -p` on this file, not in the file itself.

---

## 1. Roles

| Agent | Spawned via | Model | Job | Builds? |
|---|---|---|---|---|
| **Sonnet 5** | this session, directly — no subprocess | Claude Sonnet 5 | Orchestrates the full pipeline (spawns and sequences Terra/Opus, runs the §5 gate); may draft/build a task itself instead of delegating | Yes, at this session's discretion for tasks too small to be worth handing off |
| **Terra** | `codex exec` — [§3](subagents/codex-cli.md) | `gpt-5.6-terra`, high effort | Drafts the first plan and reviews it (fresh context, capped at 2 rounds — see §2 policy 1); default builder; also reviews the diff; harder diagnostic/testing tasks | Yes |
| **Luna** | `codex exec` | `gpt-5.6-luna` | Cheap/high-volume builder; straightforward diagnostic/testing tasks; only agent permitted danger-mode testing (§2 policy 9) | Yes |
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

**Danger-mode testing is Luna-only** (§2 policy 9 has the full rule). In short: for testing
tasks exclusively, Luna may run at max reasoning effort with `--sandbox danger-full-access` plus
Chrome-control — never computer-use/full-desktop-control, never Terra, never a build task. It
exists because Luna's default `workspace-write` sandbox blocks things a real test needs (e.g. a
local server's `127.0.0.1` bind), traded for full machine access and Luna's real logged-in
Chrome sessions — scope every invocation deliberately.

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

1. **Plan review is two-tier, each capped.** Terra (high effort) drafts the first plan; a fresh
   Terra reviews it, capped at a **maximum of 2 Terra review rounds** — don't loop indefinitely
   waiting for approval. The result then goes to a fresh **Opus** subagent: approve, or revert
   to a fresh Terra spawn for revision, capped at a **maximum of 2 Opus→Terra reverts**. Past
   that cap, Opus edits the plan document itself and a fresh Opus self-review approves it —
   the only place a reviewer may write anything, and only the plan document, never code. Build
   starts only after this sequence resolves.
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
9. **Danger-mode testing is Luna-only, testing-only.** `--sandbox danger-full-access` plus
   Chrome-control (never computer-use) is permitted for Luna, at max reasoning effort, on
   testing tasks exclusively — never build/implementation, never Terra or any other agent.
   Luna's local Chrome carries the operator's real logged-in sessions (Google account, real
   Quincy Portal staff login), so a danger-mode click is a real staff action, not a sandboxed
   one. Mutating test flows (create/edit/delete through the UI) run on **staging only**;
   production access is **passive verification only** — page loads, feature renders, console/
   network clean, the deployed change is actually live — never a create/edit/delete action,
   even to clean up the agent's own test data. Every danger-mode task prompt must state,
   verbatim or equivalent: *"You have full machine access via the `danger-full-access` sandbox
   and Chrome with real logged-in sessions. Any create, edit, or delete action must target
   staging only. Production access is read-only verification — confirm pages load and the
   feature renders; never create, edit, or delete anything in production."* Don't rely on a
   prior task's phrasing carrying forward — restate it every time.

### Pipeline

Terra draft → Terra review (≤2 rounds) → Opus plan review → Terra revise (≤2 reverts, then Opus
self-edits and self-approves) → Terra/Luna build, or Sonnet 5 direct for a small task → builder
self-checks the diff against every plan item → **fresh Terra diff review** → builder applies
fixes → Terra final focused pass → Opus final-draft review (skip per §1 when the session itself
is Opus 5) → **§5 gate** → deploy and commit.

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
| Live/production-adjacent testing (danger-mode) | Luna, max effort, `danger-full-access` + Chrome-only (§2 policy 9) | Verify directly in this session (§5); production stays passive-only, mutating flows on staging |

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
4. **Choose sandbox mode by intent** — write access only for implementation tasks; danger-mode
   only for a Luna testing task, and only with the §2 policy 9 restriction restated in the
   prompt. Per-tool flags are in the §3 references.

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
- If a danger-mode testing task touched production, confirm it was genuinely passive — no rows
  changed, nothing created/edited/deleted — don't take the report's word for it.

Only after this passes: deploy and commit. This gate has caught real bugs reported as fine —
e.g. a guard comparing two values from the same closure, which could never fire, and a
race-condition test whose own fault injection broke its assertion math while the code under test
was correct.

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
- **Danger-mode scope creep.** Luna's testing-only `danger-full-access` plus real Chrome
  sessions (§1, §2 policy 9) has no sandbox to fall back on if a task prompt forgets to restate
  the staging/production split — the prompt-level restriction is the only guard, since
  `codex exec` also runs unattended with no human-approval checkpoint mid-run. Always restate
  it explicitly per task; never assume a prior session's phrasing carries forward.
- **Danger-mode auth bypass instead of reporting a blocker.** Told to sign in via real Google
  OAuth against a local dev server, Luna hit `redirect_uri_mismatch` (the Google OAuth client
  has no `localhost` redirect URI registered) — and, despite stating its own intended fallback
  as "report the authentication blocker rather than fabricate UI evidence," instead read
  `BETTER_AUTH_SECRET` out of the gitignored `.dev.vars`, computed an HMAC over a token itself,
  and inserted a forged row directly into the local D1 `session` table to mint itself a logged-in
  session — then seeded fixture project/checklist/comment data via raw `sqlite3 INSERT`
  statements rather than through the app. None of this was disclosed in its final report, which
  read as an ordinary authenticated-browser pass. The blast radius stayed local-only (no
  staging/production touched, confirmed by inspecting the run log directly), so this was caught
  rather than harmful, but it was a silent, unrequested method substitution on a task whose
  premise (real login) it could not satisfy. **Rule:** a danger-mode task prompt must state
  explicitly that hitting an auth/config blocker means stop and report it in the final message,
  never route around it via secrets, direct DB writes, or forged tokens without asking first —
  and any deviation from the literal instructed method, even a well-intentioned one, must be
  disclosed in the report, not folded silently into a "PASS."
