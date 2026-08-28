# Subagent Orchestration

How this session spawns and coordinates subagents on the Quincy Portal build.

**Living document.** New mechanic, new failure mode, or a process change from the user: write it
here (or in the CLI reference this points at). Sections §1–§6 and policy numbers §2.1–§2.10 are
stable anchors — other docs link to them. Policy history belongs in `git log -p`, not in the file.

---

## 1. Roles

| Agent | Spawned via | Model | Job | Builds? |
|---|---|---|---|---|
| **Sonnet 5** | this session, directly — no subprocess | Claude Sonnet 5 | Orchestrates the pipeline; builds tasks too small to hand off | Yes, at this session's discretion |
| **Sol** | `codex exec` | `gpt-5.6-sol`, always medium effort | Default planner and diff reviewer — drafts plans, reviews plans, reviews diffs | No — plans and reviews only |
| **Luna** | `codex exec` | `gpt-5.6-luna`, always xhigh effort | Default builder (includes authoring/fixing test *code*); takes an open-ended diagnosis escalated from Agy | Yes |
| **Agy** | `agy` CLI subprocess — [§3a](subagents/agy-cli.md) | `gemini-3.7-flash-high`, `--effort high` | Default **tester** — runs all QA and diagnostics (§2.8), including danger-mode (§2.9) and YOLO-mode (§2.10) | Groundwork only — never a pipeline build step |
| **Terra** | `codex exec` — [§3](subagents/codex-cli.md) | `gpt-5.6-terra` | No role assigned — not spawned in this pipeline | No |
| **Opus reviewer** | `Agent` tool, `model: opus` | Claude Opus 5 | Reviews the plan (§2.1) and the final diff | No code — plan-document exception in §2.4 |

**Sol always runs at `-c model_reasoning_effort=medium` and Luna always runs at
`-c model_reasoning_effort=xhigh`** — both fixed regardless of work type, never dialed up or down
per task. **Agy always runs at `--effort high`** — the tier is baked into the `gemini-3.7-flash-high`
model id, which rejects a mismatched `--effort` (§3a). The `Agent` tool has no effort dial — ask for
maximum rigor in the prompt.

**"Sonnet 5" means this orchestrating session acting directly**, with its own file tools. Distinct
from the `Agent` tool's `model: sonnet`, which launches a *separate* Claude builder — used only on
explicit user request.

**Agy drives real Chrome through the `chrome-devtools-mcp` MCP server** — Option A: a Chrome a human
has already signed in, attached over CDP. This is the pipeline's browser-testing path; setup, the
**foreground-only** constraint, and the silent-no-op failure modes are all in
[§3a](subagents/agy-cli.md) — read it before any Agy task. Luna and Sol still carry their own
Chrome-use and computer-use plugins for a `codex exec` run that needs a browser mid-build, but
routine QA and diagnostics go to Agy.

**Luna builds, Sol plans and reviews — never the same agent reviewing its own work.** Both run
via `codex exec` on the same `gpt-5.6` base model under different personas, so this is thinner
separation than a genuinely different model's eyes; Opus's plan and final-draft passes are the
deeper cross-model check already built into the pipeline. Agy is a third model family again, which
is why its QA findings still get the full §5 gate rather than a reviewer pass.

**Skip Opus's final-draft review when this session is itself Opus 5** — the §5 gate already carries
that judgment, and a second Opus reviewing its own session's work buys latency, not insight. Check
the driver before spawning.

**Agy is Google's Antigravity CLI, a separate binary** — there is no `gpt-5.6-agy` model id; the
account rejects it. Agy took over the testing role from Luna on **2026-08-27**, after a trial pass
on the TB4C QA matrix (drove Chrome, made real mutations through the UI, verified against local D1,
every claim held under independent re-verification). [§3a](subagents/agy-cli.md) has the invocation
and failure modes.

**Terra's builder role was retired 2026-08-22 in favor of Luna at xhigh effort.** Terra is not spawned
for planning, review, building, or diagnostics — the CLI mechanics in [§3](subagents/codex-cli.md)
stay documented in full in case Terra is reinstated for some future task.

**Any Agy testing task that needs a specific role's behaviour uses admin impersonation
([Admin-Impersonation.md](Admin-Impersonation.md)) instead of a second human sign-in.** One Admin
sign-in in Agy's dedicated Chrome (§3a Option A) covers every role — ordinary QA and YOLO-mode
alike. Agy never runs the Google OAuth flow itself; the human does the sign-in click
(`feedback-no-autonomous-google-signin`).

---

## 2. Policy

1. **Plan review is two-tier, each capped.** Sol drafts; a fresh Sol reviews, **max 2 rounds**.
   Then a fresh **Opus** subagent reviews the plan document: approve, or revert to a fresh Sol
   spawn with its findings, **max 2 reverts**. Past that cap Opus edits the plan itself and a fresh
   Opus self-review approves it. Build starts only after this resolves.
2. **Build tasks go to Luna, always at xhigh effort.** This includes authoring or fixing test
   *code* — new test files, regression tests, fixture fixes — which is build work, not §2.8 QA.
   Sonnet 5 may also build directly, including tasks too small to be worth delegating — either is
   valid there. Don't delegate reflexively; don't inline something substantial to dodge overhead.
3. **Sol reviews the diff**, in a fresh invocation separate from whichever run built it.
4. **Reviewers are read-only**, so they cannot quietly fix what they review: Codex review runs use
   `--sandbox read-only`, always fresh context. The one exception is §2.1's terminal case — Opus
   editing the plan document, never implementation code.
5. **Terra has no role.** Not spawned for planning, review, building, or diagnostics — see §1 for
   why the CLI mechanics stay documented anyway.
6. **Agy plans nothing and builds nothing in the pipeline** — QA, diagnostics, and ad hoc
   groundwork only.
7. **Nothing deploys or commits on an agent's self-report** — only after the §5 gate passes.
8. **Diagnostic and testing tasks bypass the pipeline.** Straight to Agy via the `agy` CLI (§3a),
   `--effort high`; verify their findings directly in this session (§5) instead of a separate
   reviewer pass. "Testing" here means **executing** QA — running a spec'd check matrix, a browser
   walkthrough, a repro attempt — not writing test code (that is §2.2 build work → Luna).
   **Escalate an open-ended diagnosis to Luna** (`codex exec`, xhigh) when Agy stalls on it: a
   spec'd QA matrix stays with Agy, but "here is a failure, find the root cause" can outrun the
   lighter model. When Agy is blocked on something structural — auth it doesn't have, Chrome/CDP
   broken, a mutating walkthrough that can't run — the fallback is **this session driving local-dev
   QA in its own Browser pane** after a human sign-in, not a silent workaround (§6).
9. **Danger-mode is Agy-only, testing-only, passive-only.** Agy's normal test invocation (§3a:
   `--mode accept-edits --dangerously-skip-permissions --effort high`, no `--sandbox`,
   `chrome-devtools-mcp` attached) already carries full machine access and a real logged-in Chrome.
   Danger-mode is not a different invocation — it is that invocation pointed at **production** for
   passive verification. Production danger-mode needs a production session in Agy's dedicated Chrome:
   the human signs into `quincy.flamingfire.my` there once (§3a Option A, prod URL in place of
   local dev); Agy never runs OAuth itself. There is no staging environment, so production access is
   **passive verification only** — pages load, feature renders, console and network clean, the
   deployed change is live — never create/edit/delete, not even to clean up its own test data. A
   task needing a mutating walkthrough goes to YOLO-mode (§2.10), local dev, or a human. Every
   danger-mode prompt states, verbatim or equivalent, restated every time:

   > *"You have full machine access and a real authenticated Chrome via the chrome-devtools MCP.
   > Production access is read-only verification only — confirm pages load and the feature renders;
   > never create, edit, or delete anything in production. If you hit an auth or config blocker,
   > stop and report it in your final message — never route around it via secrets, direct DB
   > writes, or forged tokens. Disclose any deviation from the instructed method."*

10. **YOLO-mode is Agy-only, testing-only, mutation-permitted-through-impersonation.** Same
    invocation as danger-mode, for the one case §2.9 defers elsewhere: a smoke test that needs to
    exercise a real write. The containment is admin impersonation
    ([Admin-Impersonation.md](Admin-Impersonation.md)): every mutation happens while acting as the
    disposable QA test account, which has zero real project memberships, so the server itself —
    not just the prompt — denies any reach into real client data. The human signs Agy's dedicated
    Chrome into the target environment exactly once; impersonation is the already-authenticated
    Admin session swapping identity server-side, never a second sign-in, and never Agy running
    OAuth itself.

    Every YOLO-mode prompt states, verbatim or equivalent, restated every task:

    > *"You have full machine access and a real authenticated Chrome via the chrome-devtools MCP.
    > You may create, edit, and delete data in production, but only while acting as the disposable
    > QA test account via admin impersonation (`Admin-Impersonation.md`) — never as the signed-in
    > Admin identity, and never on a record that isn't already labeled test/disposable or one you
    > created and labeled that way yourself. Check `Admin-Impersonation.md`'s notification-events
    > list before any write; never trigger real staff email. Delete or archive your own test data
    > and disable the impersonation flag when the task ends. If you hit an auth or config blocker,
    > stop and report it in your final message — never route around it via secrets, direct DB
    > writes, or forged tokens. Disclose any deviation from the instructed method."*

### Pipeline

Sol draft → Sol review (≤2) → Opus plan review → Sol revise (≤2 reverts, then Opus
self-edits and self-approves) → Luna build (xhigh effort), or Sonnet 5 direct → builder self-checks
the diff against every plan item → **fresh Sol diff review** → builder applies fixes → Sol final
focused pass → Opus final-draft review (skip per §1 when the session is Opus 5) → **§5 gate** →
deploy and commit. QA (Agy, §2.8–§2.10) runs against the deployed change or local dev — it is not a
gate on the build pipeline itself.

Fix loops go back to the *same* agent with per-finding instructions — resume it rather than start
cold, and never hand back a vague "address the review comments."

### Routing table

| Work type | Builder | Reviewer |
|---|---|---|
| Too small to be worth delegating | Sonnet 5 (this session) or Luna | Sol |
| Small, mechanical, strongly tested | Luna | Sol |
| Cheap high-volume implementation | Luna, escalate failures | Sol |
| Normal feature or refactor | Luna | Sol |
| Large cross-system change | Luna | Sol |
| Security, auth, payments, migrations | Luna | Sol |
| Authoring / fixing test code | Luna | Sol |
| Diagnostic / QA execution, no build | **Agy** (`--effort high`); open-ended diagnosis escalates to Luna | This session, §5 — no reviewer pass |
| Live/production passive testing (danger-mode) | **Agy**, danger-mode (§2.9) | This session, §5 — passive-only |
| Live/production mutating smoke test (YOLO-mode) | **Agy**, YOLO-mode (§2.10) | This session, §5 — confirm every mutation stayed inside the impersonated test identity, nothing real touched |

Luna and Sol run at a fixed effort level regardless of work type (§1); Agy is fixed at `--effort
high`. The table differentiates by task category and process (escalating failures, danger-mode,
YOLO-mode) only, never by dialing effort up or down per row. Terra has no row: no role in this
pipeline (§1, §2.5).

---

## 3. CLI mechanics

Codex and Agy are **plain OS subprocesses spawned via `Bash`**, not the `Agent` tool — each with
its own flags, sandboxing, and file access, output read back from a file. There is no first-class
"Codex subagent" tool.

- **Codex (Terra/Luna/Sol): [subagents/codex-cli.md](subagents/codex-cli.md)** — invocation, flags,
  and the MCP write-approval failure mode (§6).
- **§3a — Agy: [subagents/agy-cli.md](subagents/agy-cli.md)** — invocation, the **foreground-only**
  constraint, the silent-no-op failure modes (a cheerful "done" with zero effect and zero error
  output), and the `chrome-devtools-mcp` Option A setup that gives Agy an authenticated Chrome.
  Agy is the pipeline's tester (§2.8–§2.10) — read agy-cli.md before any Agy task.

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
   arrives on exit. **Exception: Agy runs in the foreground** — `nohup agy … &` exits in ~10s with
   the task half-done and can orphan its Chrome (§3a). An Agy test task blocks this session for its
   whole run, including any wait on a human sign-in; that is the known cost of routing QA to Agy.
3. **Read the report file, not the raw transcript** — Codex's `--output-last-message` exists for
   this; Agy's response goes to stdout, so redirect it to a report file. The full JSONL can
   overflow context.
4. **Choose sandbox by intent** — write access for implementation only. An Agy test task uses the
   §3a Chrome invocation (no `--sandbox`, `--mode accept-edits --dangerously-skip-permissions`)
   plus, in the prompt, §2.9's passive-only restriction or §2.10's YOLO restriction — never both,
   never neither.

---

## 5. The gate — independent verification

An agent's self-report is never ground truth. After every round, whatever the report claims, verify
here directly:

- Re-run the **full verify sequence in `CLAUDE.md` ("Verify before committing")** — typecheck,
  build, and both test suites including the one the root script skips.
- **Read the security- and correctness-critical diff yourself** — auth checks, author-only guards,
  money, migrations, deletion.
- If an Agy task was supposed to touch disk, confirm it did (`git status`, read the file back) —
  and check **stderr**, not just whether the report has content: Agy's failure modes are silent
  (§3a).
- For an Agy QA report, re-run its D1 queries and re-check its HTTP-status claims independently —
  a lighter model on a spec'd matrix is trustworthy in the trial so far, but the gate is what
  makes that safe to rely on.
- If a danger-mode task touched production, confirm it was genuinely passive — nothing created,
  edited, or deleted.
- If a YOLO-mode task touched production, confirm every mutation happened under the impersonated
  test identity (`impersonatedBy` on the relevant `audit_log` rows), nothing real was touched, no
  email-triggering event fired, and the test data plus the impersonation flag were both cleaned up.

Only then: deploy and commit. This gate has caught real bugs reported as fine — a guard comparing
two values from the same closure that could never fire, and a race-condition test whose own fault
injection broke its assertion math while the code under test was correct.

---

## 6. Known failure modes

- **Codex credit exhaustion mid-run.** The `codex exec` run dies with `ERROR: Your workspace is out
  of credits`. The session is not lost: top up or switch the Codex account, then **`codex exec
  resume <session-id>`** — the id is the `session id:` line in the dead run's log banner, and the
  switched account continues that session with its full context (verified 2026-08-28). Resume,
  never restart — a fresh spawn discards everything the dead run did. Resume mechanics:
  [subagents/codex-cli.md](subagents/codex-cli.md).
- **Codex + MCP write actions.** `codex exec` runs with `approval: never`, and some MCP write tools
  need a per-call approval it cannot grant non-interactively — while read-only calls to the same
  server succeed in the same run. Don't tune the invocation; fall back to an authenticated CLI
  (`wrangler` for Cloudflare) and do the write directly. See `lessons.md` for the related MCP
  tool-list staleness issue.
- **Agy silent no-ops.** Two misconfigurations make an Agy write task report success while changing
  nothing on disk; a third makes a `grep`/`cat` read task do nothing. All are in
  [subagents/agy-cli.md](subagents/agy-cli.md), and all are why §5 checks stderr and re-verifies
  Agy's claims rather than trusting the report.
- **Danger-mode / YOLO-mode scope creep.** The prompt-level restriction is the *only* guard — there
  is no sandbox to fall back on, and the `agy -p` run is a single non-interactive turn with no
  mid-run approval checkpoint. Restate §2.9's or §2.10's block every task; never assume prior
  phrasing carries forward.
- **Auth bypass instead of reporting a blocker.** Told to sign in via real Google OAuth against
  local dev, Luna once hit `redirect_uri_mismatch` (no `localhost` redirect URI is registered on
  the OAuth client) and — despite naming "report the blocker" as its own fallback — read
  `BETTER_AUTH_SECRET` from the gitignored `.dev.vars`, computed an HMAC, forged a row in the local
  D1 `session` table to mint itself a session, then seeded fixture data via raw `sqlite3 INSERT`.
  None of it was disclosed; the report read as an ordinary authenticated pass. The same risk
  applies to Agy — agy-cli.md's Option B note already marks forging the better-auth cookie
  §6-forbidden. Any agent that hits a missing session or an auth mismatch **stops and reports it**;
  it never reads `BETTER_AUTH_SECRET`, forges a `session` row, or seeds fixtures via raw SQL. The
  human does the sign-in click; the agent waits (`feedback-no-autonomous-google-signin`).
