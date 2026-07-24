# Codex Subagent Orchestration Guide

> Reference for how this session (the main agent) spawns and coordinates Codex subagents
> (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) on the Quincy Portal build. Written to be
> read and followed directly by an agent, not just as a session history. Policy last updated
> 2026-07-24 per user direction; CLI mechanics verified against the live `codex` CLI on
> 2026-07-19.

---

## 1. Roles

| Agent | Model | Default job | Builds? |
|---|---|---|---|
| **Sol** | `gpt-5.6-sol` | Plans and reviews | Only when explicitly requested by the user, or for security/auth/payments/migrations and (at the user's discretion) large cross-system changes — see routing table |
| **Terra** | `gpt-5.6-terra` | Default builder; this account's default Codex model | Yes — default builder for normal feature/refactor work |
| **Luna** | `gpt-5.6-luna` | Cheap/high-volume builder | Yes — small, mechanical, strongly-tested work |

All three run at `model_reasoning_effort=high` unless a task specifically calls for
something else.

---

## 2. Policy rules

1. **Plans are drafted by the main agent, then must be Sol-reviewed before build starts.**
   This session may draft the implementation plan directly. The plan is not authoritative
   until `gpt-5.6-sol` (`--sandbox read-only`, `model_reasoning_effort=high`) has reviewed
   it and the plan has been revised to address that review.
2. **Build work goes to Terra or Luna, not Sol.** Assign implementation tasks to
   `gpt-5.6-terra` or `gpt-5.6-luna`, both at high effort. **Never assign `gpt-5.6-sol` to a
   build task** unless the user explicitly asks for it for that specific task, or the work
   falls in a "Sol builds" row of the routing table below.
3. Deploy and commit only after this session's own independent verification passes (§5) —
   never on an agent's self-report alone.

### Reference pipeline

The full plan → build → review → fix cycle, in order:

1. **Sol** — inspect the repository and produce an implementation plan.
2. **Terra** — implement the plan and run tests.
3. **Terra** — self-check the diff against every plan item.
4. **Sol, fresh context** — review the actual diff (not the plan).
5. **Terra** — apply clearly identified fixes from the review.
6. **Sol** — final focused review for unresolved high-severity issues.

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
`subagent_type: general-purpose`, `model: sonnet`); use that only when the user
specifically asks for a Claude-side builder instead of a Codex one. There is no first-class
"Codex subagent" tool — Codex is invoked as a plain CLI subprocess, with its own sandboxing
and file access, and its output is read back from a file.

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
