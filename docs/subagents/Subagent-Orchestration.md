# Subagent Orchestration

How this session spawns and coordinates subagents.


This doc is the roster and the how-to: who's available, what each is for, and the
mechanics of spawning them. 

---

## 1. Roles

| Agent | Spawned via | Model | Job |
|---|---|---|---|
| **The session** | runs in Claude Code| whichever Claude model the user started on: Sonnet, Opus, Fable, any | Orchestrates: plans, decomposes, delegates, synthesizes, at its own discretion |
| **fast-worker** | `Agent` tool, `subagent_type: fast-worker` (`~/.claude/agents/fast-worker.md`) | Claude Sonnet 5 | **Default builder** — mechanical, well-specified work: boilerplate, tests, formatting, straightforward edits. Stops and reports back on anything ambiguous or design-level rather than guessing |
| **deep-reasoner** | `Agent` tool, `subagent_type: deep-reasoner` (`~/.claude/agents/deep-reasoner.md`) | Claude Opus 5 | Reasoning-heavy phases: architecture decisions, hard debugging, algorithm design, tradeoff analysis. Returns a concise, actionable conclusion |
| **Sol** | `codex exec` — [§3](codex-cli.md) | `gpt-5.6-sol`, always high effort | Diff reviewer |
| **Luna** | `codex exec` — [§3](codex-cli.md) | `gpt-5.6-luna`, always xhigh effort | Tester — QA execution, diagnosis, authoring/fixing test code, and any Chrome/browser pass |
| **Codex (peer)** | `/codex:rescue --background` | shared Codex runtime | A second, independent-model-family opinion on high-stakes decisions — a peer worked in parallel with Opus/deep-reasoner, not a reviewer of their output |
| **Terra** | `codex exec` — [§3](codex-cli.md) | `gpt-5.6-terra` | No default role — available as an on-request builder when the user asks for a Codex-driven build by name |
| **Astra** | `codex exec` — [§3](codex-cli.md) | `gpt-6-astra` | No default role — available on request; pass `-m gpt-6-astra` explicitly, the account default doesn't reliably select it |
| **Agy** | `agy` CLI subprocess — [§3a](agy-cli.md) | `gemini-3.8-flash-high`, `--effort high` | Dormant by default — testing and ad hoc groundwork only, never planning or building; available on request when the user asks for it by name |


**"The session" means whoever is reading this**, acting directly with its own file tools. The
roster is model-agnostic by design: it names *roles*, never the session's model, so the same
routing holds whether the user started on Sonnet, Opus or Fable. Distinct from the `Agent` tool's
`fast-worker`/`deep-reasoner` subagents, which are separate Claude processes with their own scoped
system prompts.




**Any testing task that needs a specific role's behaviour uses admin impersonation**
([Admin-Impersonation.md](../Guides/Admin-Impersonation.md)) instead of a second human sign-in 

## 2. Policy




1. **Agents may self-mint a session**. Reading `BETTER_AUTH_SECRET`
   from `.dev.vars` or Worker secrets, computing the HMAC, and writing a `session` row to reach an
   authenticated page is a **sanctioned technique**. It is the standing answer to a missing session, and it exists so that no agent is ever cornered
   into the one thing that stays off-limits: **running Google OAuth against the owner's real
   account** — a human does every sign-in click (`feedback-no-autonomous-google-signin`).

   Two rules bound it, and they carry the whole policy:

   - **A self-minted production session is passive.** Read, measure, screenshot, verify. Writes on
     production keep the YOLO-mode path — a human-authenticated Admin plus impersonation —
     because that is what makes a mutation *attributable*. A self-minted session writing to
     production would stamp `audit_log` rows with a real user's identity for an action no human
     took, which is the integrity property the author-only annotation rules exist to protect.
     Local dev has no such constraint: mint and mutate freely.
   - **Say that you did it.** Name the technique in the final report, every time. 
## 3. CLI mechanics

Codex and Agy are **plain OS subprocesses spawned via `Bash`**, not the `Agent` tool — each with
its own flags, sandboxing, and file access, output read back from a file. There is no first-class
"Codex subagent" tool. fast-worker and deep-reasoner go through the `Agent` tool instead (§1),
and Codex-as-peer goes through `/codex:rescue --background`.

- **Codex (Sol/Luna/Terra/Astra): [codex-cli.md](codex-cli.md)** — invocation, flags, driving
  Chrome for Luna's testing pass, and the MCP write-approval failure mode (§6).
- **§3a — Agy (dormant, on-request): [agy-cli.md](agy-cli.md)** — invocation, the backgrounding and
  print-mode shutdown-hang failure modes (a long run whose report never lands, recoverable from the
  conversation DB), the silent-no-op failure modes (a cheerful "done" with zero effect and zero
  error output), and the `chrome-devtools-mcp` Option A setup that gave Agy an authenticated
  Chrome — all still current, kept for reactivation.

---

## 4. Spawn procedure

Applies to Codex/Agy subprocesses and to `Agent`-tool Claude subagents — not to this session
planning or building inline (§1).

1. **Write the spec to a scratchpad file first** — never inline a whole task as a raw string. Keeps
   prompts reviewable and reusable when a fix loop needs a second round.
2. **Launch in the background** (`Bash`, `run_in_background: true`), passing the spec as the
   subprocess prompt and capturing the final report to its own file, so orchestration continues
   and a notification arrives on exit. This holds for Agy too, if reactivated: its prompt is a
   `--print=` argument, not stdin, so harness-supervised backgrounding is safe. Only a bare
   `nohup agy … &` fails at launch — it closes stdin and dies in ~10s (§3a). Separately, a long
   Agy run that leaves a server it started running async hangs at shutdown until `--print-timeout`
   and loses its printed report — never let Agy start `wrangler dev`; bring it up first (§3a).
3. **Read the report file, not the raw transcript** — Codex's `--output-last-message` exists for
   this; Agy's response goes to stdout, so redirect it to a report file. The full JSONL can
   overflow context.

---

## 5. The gate — independent verification

An agent's self-report is never ground truth. After every round, whatever the report claims, verify
here directly:

- **Read the security- and correctness-critical diff yourself** — auth checks, author-only guards,
  money, migrations, deletion.

- If an agent is spawned and a danger-mode task touched production, confirm it was genuinely passive —
  nothing created, edited, or deleted. If a YOLO-mode task touched production, confirm every
  mutation happened under the impersonated test identity (`impersonatedBy` on the relevant
  `audit_log` rows), nothing real was touched, no email-triggering event fired, and the test data
  plus the impersonation flag were both cleaned up. Check **stderr**, not just whether the report
  has content: Agy's failure modes are silent (§3a).

Only then: deploy and commit. This gate has caught real bugs reported as fine — a guard comparing
two values from the same closure that could never fire, and a race-condition test whose own fault
injection broke its assertion math while the code under test was correct.

---

## 6. Known failure modes

- **Codex credit exhaustion.** A `codex exec` run dies mid-task with `ERROR: Your workspace is out
  of credits` — chronic on this workspace, and top-ups get consumed within a run or two, so
  provision for the whole revise→review→build→diff-review cycle before starting one. The session
  survives: top up or switch the Codex account, then **`codex exec resume <session-id>`** (id from
  the dead run's log banner) continues it with full context — the switched account picks it up.
  Resume is *only* for this; every new task, each fix round included, starts a fresh `codex exec`.
  Invocation: [codex-cli.md](codex-cli.md).
- **Codex + MCP write actions.** `codex exec` runs with `approval: never`, and some MCP write tools
  need a per-call approval it cannot grant non-interactively — while read-only calls to the same
  server succeed in the same run. `-c approval_policy="never"` does not help: the gate is per-tool,
  not policy-driven. Where an authenticated CLI can do the write instead (`wrangler` for
  Cloudflare), fall back to that rather than tuning the invocation. The **one** case with no such
  fallback is `chrome-devtools-mcp`'s `evaluate_script`, which is the entire point of a browser
  measurement pass — that case, and only that case, is what Luna's unsandboxed mode exists for.
  See `../lessons.md` for the related MCP tool-list staleness issue.

