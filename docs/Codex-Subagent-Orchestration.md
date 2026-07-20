# How Codex subagents were spawned in this session

> Written for the record, at the user's request. Reflects the actual commands used during
> the Quincy Portal build, verified against the live `codex` CLI on this machine on
> 2026-07-19.

---

## Direct answer: can I spawn Codex at `gpt-5.6-sol`, high effort?

**Yes — confirmed by an actual test run, not assumption.**

```bash
codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=high "..."
```

This account's **default** model (from `~/.codex/config.toml`) is `gpt-5.6-terra` at
`model_reasoning_effort = "high"` — that's what every Codex subagent in this session ran on
unless told otherwise. `gpt-5.6-sol` is a different, also-valid model on this account; passing
`-m gpt-5.6-sol` overrides the default for a single invocation. There's no dedicated
`--reasoning-effort` flag — effort is set via the generic config override,
`-c model_reasoning_effort=<value>`.

---

## Mechanism: `codex exec` as a real subprocess, not the `Agent` tool

Two different "subagent" mechanisms were used in this session, and they are not the same thing:

| Mechanism | What it is | Used for |
|---|---|---|
| `Bash` → `codex exec ...` | Spawns the actual **Codex CLI** as a separate process, running on OpenAI's model | Every "Codex subagent" in this session — implementation waves (Phase 0–2, later features) and independent code review |
| `Agent` tool, `subagent_type: general-purpose`, `model: sonnet` | Spawns a Claude subagent inside this same harness | The one Sonnet-5 implementation task (WP-M) the user explicitly asked to route that way |

There is no first-class "Codex subagent" tool in this harness — Codex is invoked as a plain
CLI subprocess via `Bash`, with its own sandboxing and file access, and its output is read
back from a file.

---

## The actual spawn pattern

1. **Write a precise spec to a scratchpad file first**, always — never inline the whole task
   as a raw string. This kept prompts reviewable and made the exact same spec reusable for a
   follow-up round if a fix loop was needed.

   ```
   Write(file_path=".../scratchpad/wp-x-taskname.md", content="<the full spec>")
   ```

2. **Launch it as a background Bash command**, reading the spec back in via `cat`, and
   capturing the agent's final report to its own file:

   ```bash
   SCRATCH=".../scratchpad"
   cd "<repo root>" && codex exec \
     --sandbox workspace-write \
     --output-last-message "$SCRATCH/wp-x-report.md" \
     "$(cat "$SCRATCH/wp-x-taskname.md")" \
     > "$SCRATCH/wp-x-run.log" 2>&1
   ```

   Run via the `Bash` tool with `run_in_background: true` so orchestration work continues in
   parallel; a task-notification arrives when the process exits.

3. **Sandbox mode is chosen by intent**, not by default:
   - `--sandbox workspace-write` — for implementation tasks (the agent needs to edit/create
     files).
   - `--sandbox read-only` — for **review-only** tasks. This was used every time Codex was
     asked to review a diff rather than write code, so it structurally cannot "fix while
     reviewing."
   - One provisioning attempt (real Cloudflare account writes via the Cloudflare MCP) added
     `-c 'sandbox_workspace_write.network_access=true'` since MCP calls need network. That
     specific attempt still failed — see "Known failure mode" below.

4. **Read the report file, never the raw transcript.** `--output-last-message` writes just the
   agent's final message to a clean file; the harness explicitly warns against reading the
   full JSONL transcript directly, since it can overflow context.

5. **Independently re-verify — never trust the agent's self-report as ground truth.** Every
   round, regardless of what the report claimed, the same verification commands were re-run
   directly:
   ```bash
   npx tsc -p <workspace>/tsconfig.json      # per workspace
   npx vitest run --config workers/app/vitest.config.ts
   npm run build -w @quincy/web
   ```
   This caught real bugs the agent's own report claimed were fine (e.g. a guard that compared
   two values from the same closure and therefore could never fire).

6. **Deploy and commit only after independent verification passes.**

---

## The build → review → fix loop (used for the higher-stakes UI work)

For one feature (lightbox markup editing), the user explicitly asked for a three-stage
pipeline: a Sonnet-5 builder, a Codex reviewer, and this session as the final gate, looping
until clean. The loop in practice:

1. **Sonnet 5 builds** (via the `Agent` tool, `model: sonnet`, high effort), against a
   detailed spec, with its own verification bar (typecheck, tests, build) before reporting.
2. **Codex reviews**, read-only, against a written checklist (per-item severity, file:line
   evidence, an explicit APPROVE / REQUEST-CHANGES verdict) — same `codex exec --sandbox
   read-only` pattern as above, pointed at the live `git diff` instead of a spec.
3. **This session re-verifies independently** (re-running the test suite, and personally
   reading the security-sensitive parts of the diff — auth checks, author-only guards).
4. If Codex's verdict was REQUEST-CHANGES, the specific findings were sent back to the
   **same** builder agent (via `SendMessage` to its agent id, which resumes it with full
   context) with precise fix instructions per finding — not a vague "fix the review
   comments."
5. Repeat steps 2–4 until Codex approves AND independent verification passes. In this
   session that took three review rounds; the loop caught a genuine silent-data-loss bug
   before it ever reached production.
6. Only then: deploy + commit.

---

## Known failure mode: Codex + MCP write actions under `codex exec`

One documented failure worth keeping on record: handing Codex a task that required calling
a **write** action on a remote MCP server (Cloudflare resource provisioning) failed —
`codex exec` runs with `approval: never`, and that MCP server's write tool appears to need a
per-call approval Codex cannot grant non-interactively. Read-only MCP calls on the same
server worked fine in the same run. When this happened, the fix was **not** to keep tuning
the Codex invocation — it was to fall back to an already-authenticated CLI (`wrangler`) and
do the provisioning directly. This pattern (and the MCP-tool-list staleness issue that led to
it) is recorded in `docs/lessons.md`.

---

## Quick reference: flags actually used this session

| Flag | Purpose |
|---|---|
| `--sandbox workspace-write` | Implementation tasks — file writes allowed |
| `--sandbox read-only` | Review tasks — no file writes possible |
| `--output-last-message <file>` | Write only the final report to a clean file |
| `-m <model>` | Override the default model for one invocation (e.g. `gpt-5.6-sol`) |
| `-c model_reasoning_effort=high` | Set reasoning effort (no dedicated flag exists) |
| `-c 'sandbox_workspace_write.network_access=true'` | Allow network from workspace-write sandbox (needed for MCP calls) |

Flag that does **not** exist on `codex exec` (a mistake made once this session): `--no-terminal`
— that belongs to `acpx`'s wrapper around Claude sessions, not to the Codex CLI itself.
