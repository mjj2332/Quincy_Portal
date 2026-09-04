# Subagent Orchestration

How this session spawns and coordinates subagents on the Quincy Portal build — including
frontend/UI implementation work, which used to have its own document; §7 now covers what's
different about it.

**Living document.** New mechanic, new failure mode, or a process change from the user: write it
here (or in the CLI reference this points at). Sections §1–§7 and policy numbers §2.1–§2.9 are
stable anchors — other docs link to them. Policy history belongs in `git log -p`, not in the file.

---

## 1. Roles

| Agent | Spawned via | Model | Job | Builds? |
|---|---|---|---|---|
| **The session** | runs in Claude Code — no subprocess | whichever Claude model the user started on: Sonnet, Opus, Fable, any | Orchestrates the pipeline; **drafts every plan**; builds tasks too small to hand off | Yes, at its own discretion |
| **Sonnet** | `Agent` tool, `model: sonnet` | Claude Sonnet 5 | **Default builder — every build task**, frontend and backend alike | Yes — the default |
| **Sol** | `codex exec` | `gpt-5.6-sol`, always high effort | Default plan and diff reviewer | No — reviews only |
| **Luna** | `codex exec` | `gpt-5.6-luna`, always xhigh effort | **Default tester** — QA execution, diagnosis, authoring/fixing test code, the browser/visual pass on UI work (§2.6) | No — tests, doesn't build |
| **Opus reviewer** | `Agent` tool, `model: opus` | Claude Opus 5 | Reviews the plan (§2.1) and the final diff | No code — plan-document exception in §2.4 |
| **Terra** | `codex exec` — [§3](codex-cli.md) | `gpt-5.6-terra` | No role assigned — not spawned in this pipeline | No |
| **Agy** | `agy` CLI subprocess — [§3a](agy-cli.md) | `gemini-3.8-flash-high`, `--effort high` | **Dormant** (§2.8) — was the default tester; Luna has that role now | No — dormant |

**Sol always runs at `-c model_reasoning_effort=high` and Luna always runs at
`-c model_reasoning_effort=xhigh`** — both fixed regardless of work type, never dialed up or down
per task. The `Agent` tool has no effort dial — ask for maximum rigor in the prompt.

**"The session" means whoever is reading this**, acting directly with its own file tools. The
pipeline is model-agnostic by design: it names *roles*, never the session's model, so the same
routing holds whether the user started on Sonnet, Opus or Fable. Distinct from the `Agent` tool's
`model: sonnet`, which launches a *separate* Claude builder — now the default route for every
build task, not an escalation.

**The session's model changes exactly one thing: whether the Opus touchpoints are worth spawning.**
They exist to put a second, stronger pair of Claude eyes on a plan and a final diff. When the
session is already Opus 5 or Fable 5, the §5 gate carries that judgment and a second spawn buys
latency, not insight — skip both. On a Sonnet session, run them. Check the driver before spawning.

**Sonnet builds every build task now — plans and code both stay in the Claude family**, so design
and implementation judgment never pass to Sol, which has none: early Luna-built UI on this project
shipped with poor taste despite passing every mechanical review, and that failure mode generalizes
past UI to any task a scope-and-correctness reviewer can't catch by reading a diff. This also makes
Sol's review a genuine cross-model check — Claude builds, a different model family (GPT-5.6)
reviews — stronger separation than the old Luna-builds/Sol-reviews split, where both were the same
base model under different personas. Opus's plan and final-draft passes are a second, independent
check within the Claude family itself, on a Sonnet session (see above).

**Luna is the tester.** It absorbed two things at once: test-code authoring/fixing (previously
classified as build work, now just test work — same agent either way) and Agy's old default-tester
role, dormant rather than retired (§2.8 — reactivate it there). For UI work, Luna drives real
Chrome via `chrome-devtools-mcp` attached over CDP to the human-authenticated session; the
unsandboxed invocation this requires, and the restriction block that governs it, are in §2.6.

**Agy is Google's Antigravity CLI, a separate binary** — there is no `gpt-5.6-agy` model id; the
account rejects it. It took over testing from Luna on 2026-08-27 after a trial pass on the TB4C QA
matrix, and handed testing back to Luna when build routing moved to Sonnet (Luna needed a role;
Agy's mechanics — danger-mode, YOLO-mode, the Chrome-attach setup — are preserved intact for
reactivation, not deleted). [§3a](agy-cli.md) has the invocation and failure modes regardless of
current activation status.

**Terra's builder role was retired 2026-08-22 in favor of Luna at xhigh effort**, and Terra was
never given a role in the rebuilt pipeline either. Terra is not spawned for planning, review,
building, diagnosis, or testing — the CLI mechanics in [§3](codex-cli.md) stay documented in full
in case Terra is reinstated for some future task.

**Any Agy testing task that needs a specific role's behaviour uses admin impersonation**
([Admin-Impersonation.md](../Guides/Admin-Impersonation.md)) instead of a second human sign-in — a
policy that stands ready alongside the rest of §2.8 for whenever Agy is reactivated. One Admin
sign-in in Agy's dedicated Chrome (§3a Option A) covers every role; Agy never runs the Google OAuth
flow itself — the human does the sign-in click (`feedback-no-autonomous-google-signin`).

---

## 2. Policy

1. **The session drafts the plan; review is two-tier, each capped.** The session writes the plan
   itself — it already holds the codebase reading, the user's intent and the conversation that
   produced the task, and an agent that drafts from a brief has to rebuild all of it from a worse
   starting position. For UI/frontend work, load `/frontend-design` first and write at
   implementation-detail resolution — exact Tailwind classes/tokens, spacing scale, every
   component state (default/hover/focus/disabled/error) — never directional prose ("make it feel
   more premium"); every token traces to an existing design-system source (§7), invent none. A
   fresh Sol then reviews for scope and correctness, **max 2 rounds** — not aesthetics, Sol has no
   more taste than Luna does. Then a fresh **Opus** subagent reviews the plan document (per §1,
   skip on an Opus/Fable session): approve, or return findings the session revises and a fresh
   Opus re-reviews, **max 2 reverts**. Past that cap Opus edits the plan itself and a fresh Opus
   self-review approves it. Build starts only after this resolves.

2. **Build tasks go to Sonnet** (`Agent` tool, `model: sonnet`) — frontend and backend alike. The
   session may also build directly, including tasks too small to be worth delegating — either is
   valid there. Don't delegate reflexively; don't inline something substantial to dodge overhead.
   **Slice a plan past roughly 1,500 lines** by its own section boundaries, bottom-up so nothing is
   ever half-wired (primitives, then new components/modules, then integration, then tests and
   docs): a single builder spends its whole budget reading before it writes anything, and a
   mid-run rate-limit death then costs the entire run — TB8-04's first builder attempt died
   exactly this way at 3,623 lines, having written zero code. Give each slice agent the *exact*
   line ranges it must read in full, plus the shared constraint sections every slice needs. Each
   slice ends green on typecheck and build; only the final slice must satisfy the full gate.

3. **Sol reviews the diff**, in a fresh invocation separate from whichever run built it.

4. **Reviewers are read-only**, so they cannot quietly fix what they review: Codex review runs use
   `--sandbox read-only`, always fresh context. The one exception is §2.1's terminal case — Opus
   editing the plan document, never implementation code.

5. **Terra has no role.** Not spawned for planning, review, building, diagnosis, or testing — see
   §1 for why the CLI mechanics stay documented anyway.

6. **Luna is the tester.** QA execution, open-ended diagnosis, authoring/fixing test code, and —
   for UI work — the browser/visual pass at this repo's fixed viewports (1440×900, 1024×768,
   390×844): walk the plan's real-browser acceptance criteria, capture evidence images, report
   what it observes (console errors, failed requests, broken layout, missing focus rings, anything
   that doesn't match the plan's stated intent). Luna does **not** judge whether a design is good —
   it has no more taste than Sol; that's the session's job (§7). For non-UI work, "testing" means
   running the appropriate suite or repro and reporting results the same way. Prod stays
   passive-only; mutations go to local dev. Luna never runs Google OAuth itself — if a session is
   missing it self-mints one (§2.9) or stops and says so.

   **Reaching a browser requires the unsandboxed invocation** (owner decision, 2026-09-03).
   Attaching `chrome-devtools-mcp` to the human-authenticated Chrome works from `codex exec`, but
   only read-only tools do: `list_pages` succeeds while `evaluate_script` fails with *"requires
   approval, which is unavailable"*. `-c approval_policy="never"` does **not** lift it — the tool
   is gated independently of the approval policy. The only flag that does is
   `--dangerously-bypass-approvals-and-sandbox`, which removes the sandbox wholesale. Since every
   measurement in a browser pass is an `evaluate_script`, a sandboxed Luna cannot do this work at
   all. Full invocation in [§3](codex-cli.md) ("Driving Chrome").

   This is a real escalation and the prompt is the only guard — sharpened by history: the
   auth-bypass incident in §6 was **Luna**, which forged a `session` row rather than report a
   blocker, and disclosed none of it. Sandboxing is not what stopped that (the run was sandboxed
   and it still read `.dev.vars`), but it is what would have contained the blast radius. So every
   unsandboxed Luna run states, verbatim or equivalent, restated every task:

   > *"You are running unsandboxed for ONE purpose — driving Chrome to measure or test something.
   > Treat the repository as read-only beyond that: report any file you think needs changing and
   > leave it untouched. Keep scratch files in the scratchpad directory. The Chrome is already
   > signed in; if the session is missing or expired, self-mint one (§2.9) and say so in your
   > report. Report any other auth or config blocker rather than solving it another way. State
   > every deviation from the instructed method."*

   **The orchestrating session snapshots the repo before the spawn** — `git status --porcelain`,
   `git rev-parse HEAD`, and a `shasum` manifest of every source file — and diffs it after, at §5.
   An unsandboxed agent's "I changed nothing" is a claim like any other, and this is the one
   restriction the prompt cannot enforce on itself.

   **When Luna is blocked on something structural** — auth it doesn't have, Chrome/CDP broken, a
   mutating walkthrough it can't run — the fallback is **this session driving local-dev QA in its
   own Browser pane** after a human sign-in, not a silent workaround (§6).

7. **Nothing deploys or commits on an agent's self-report** — only after the §5 gate passes.

8. **Agy is dormant.** Not currently spawned in this pipeline — Luna covers testing (§2.6) — but
   every mechanic below stays intact, current, and ready to reactivate rather than deleted:

   - Agy never plans or builds, dormant or not — testing and ad hoc groundwork only.
   - **Danger-mode** is Agy-only, testing-only, passive-only. Agy's normal test invocation (§3a:
     `--mode accept-edits --dangerously-skip-permissions --effort high`, no `--sandbox`,
     `chrome-devtools-mcp` attached) already carries full machine access and a real logged-in
     Chrome. Danger-mode is that same invocation pointed at **production** for passive
     verification: a human signs into `quincy.flamingfire.my` in Agy's dedicated Chrome (§3a
     Option A, prod URL in place of local dev); Agy never runs OAuth itself. There is no staging
     environment, so production access is **passive verification only** — pages load, feature
     renders, console and network clean, the deployed change is live — never create/edit/delete,
     not even to clean up its own test data. A task needing a mutating walkthrough goes to
     YOLO-mode below, local dev, or a human. Every danger-mode prompt states, verbatim or
     equivalent, restated every time:

     > *"You have full machine access and a real authenticated Chrome via the chrome-devtools MCP.
     > Production access is read-only verification only — confirm pages load and the feature
     > renders; never create, edit, or delete anything in production. If the session you need is
     > missing, you may self-mint one (§2.9) and must say so in your report. Report any other auth
     > or config blocker in your final message rather than solving it another way. State every
     > deviation from the instructed method."*

   - **YOLO-mode** is Agy-only, testing-only, mutation-permitted-through-impersonation — the one
     case danger-mode defers elsewhere: a smoke test that needs to exercise a real write. Same
     invocation as danger-mode. The containment is admin impersonation
     ([Admin-Impersonation.md](../Guides/Admin-Impersonation.md)): every mutation happens while
     acting as the disposable QA test account, which has zero real project memberships, so the
     server itself — not just the prompt — denies any reach into real client data. The human signs
     Agy's dedicated Chrome into the target environment exactly once; impersonation is the
     already-authenticated Admin session swapping identity server-side, never a second sign-in,
     and never Agy running OAuth itself. Every YOLO-mode prompt states, verbatim or equivalent,
     restated every task:

     > *"You have full machine access and a real authenticated Chrome via the chrome-devtools MCP.
     > You may create, edit, and delete data in production, but only while acting as the disposable
     > QA test account via admin impersonation (`../Guides/Admin-Impersonation.md`) — never as the
     > signed-in Admin identity, and never on a record that isn't already labeled test/disposable or
     > one you created and labeled that way yourself. Check `../Guides/Admin-Impersonation.md`'s
     > notification-events list before any write; never trigger real staff email. Delete or archive
     > your own test data and disable the impersonation flag when the task ends. Your Admin session
     > here must be the human-authenticated one, never a self-minted one (§2.9) — mutations have to
     > stay attributable. Report any auth or config blocker in your final message rather than
     > solving it another way. State every deviation from the instructed method."*

   - **Reactivating Agy** means putting it back in §1's table as the default tester (or a specific
     task's tester) and saying so here — not just spawning it once off-policy.

9. **Agents may self-mint a session** (owner decision, 2026-09-03). Reading `BETTER_AUTH_SECRET`
   from `.dev.vars` or Worker secrets, computing the HMAC, and writing a `session` row to reach an
   authenticated page is a **sanctioned technique**, for Luna today and for Agy if reactivated. It
   is the standing answer to a missing session, and it exists so that no agent is ever cornered
   into the one thing that stays off-limits: **running Google OAuth against the owner's real
   account** — a human does every sign-in click (`feedback-no-autonomous-google-signin`).

   Two rules bound it, and they carry the whole policy:

   - **A self-minted production session is passive.** Read, measure, screenshot, verify. Writes on
     production keep the YOLO-mode path (§2.8) — a human-authenticated Admin plus impersonation —
     because that is what makes a mutation *attributable*. A self-minted session writing to
     production would stamp `audit_log` rows with a real user's identity for an action no human
     took, which is the integrity property the author-only annotation rules exist to protect.
     Local dev has no such constraint: mint and mutate freely.
   - **Say that you did it.** Name the technique in the final report, every time. This is the
     requirement the policy actually rests on, and §6 is why: the 2026-08 incident that once made
     this move forbidden was not bad because an HMAC got computed — it was bad because the report
     read as an ordinary authenticated pass and the substitution stayed invisible. A disclosed
     self-mint is a fine engineering shortcut; an undisclosed one corrupts every claim in the
     report around it.

### Pipeline

Session drafts → Sol review (≤2) → Opus plan review → session revises (≤2 reverts, then Opus
self-edits and self-approves) → Sonnet builds (or the session builds directly for trivial work) →
builder self-checks the diff against every plan item → **fresh Sol diff review** → builder applies
fixes → Luna tests (§2.6) → **for UI work, the session's own visual/quality review** — compares the
rendering against the plan's *intent*, not just the diff and not just Luna's report; Luna's
findings are input, not a verdict, and this step doesn't delegate — → Sol final focused pass →
Opus final-draft review → **§5 gate** → deploy and commit. Both Opus touchpoints are skipped on an
Opus/Fable session (§1).

Fix loops go back to the same *persona* — Sonnet for build fixes, a fresh Sol for a review re-run,
the session for plan revisions — in a new invocation where a subagent is involved, with a
per-finding spec written to its own scratchpad file. Sharp specifics every round, never a vague
"address the review comments." (`codex exec resume` is credit-recovery only — §6.)

---

## 3. CLI mechanics

Codex and Agy are **plain OS subprocesses spawned via `Bash`**, not the `Agent` tool — each with
its own flags, sandboxing, and file access, output read back from a file. There is no first-class
"Codex subagent" tool. Sonnet and Opus builders/reviewers go through the `Agent` tool instead —
`model: sonnet` is now the default route for every build task (§1, §2.2), `model: opus` for both
review touchpoints.

- **Codex (Sol/Luna/Terra): [codex-cli.md](codex-cli.md)** — invocation, flags, driving Chrome for
  Luna's testing pass, and the MCP write-approval failure mode (§6).
- **§3a — Agy (dormant): [agy-cli.md](agy-cli.md)** — invocation, the backgrounding and print-mode
  shutdown-hang failure modes (a long run whose report never lands, recoverable from the
  conversation DB), the silent-no-op failure modes (a cheerful "done" with zero effect and zero
  error output), and the `chrome-devtools-mcp` Option A setup that gave Agy an authenticated
  Chrome — all still current, kept for reactivation (§2.8).

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
4. **Choose sandbox by intent** — write access for implementation only. A Luna test/QA task
   (including a Chrome pass) uses §2.6's unsandboxed invocation plus its restriction block, and is
   preceded by the repo snapshot §2.6 requires. If Agy is reactivated, its test task uses the §3a
   Chrome invocation (no `--sandbox`, `--mode accept-edits --dangerously-skip-permissions`) plus,
   in the prompt, §2.8's passive-only or YOLO restriction — never both, never neither.

---

## 5. The gate — independent verification

An agent's self-report is never ground truth. After every round, whatever the report claims, verify
here directly:

- Re-run the **full verify sequence in `CLAUDE.md` ("Verify before committing")** — typecheck,
  build, and both test suites including the one the root script skips.
- **Read the security- and correctness-critical diff yourself** — auth checks, author-only guards,
  money, migrations, deletion.
- **For a Luna QA report, re-run its D1 queries and re-check its HTTP-status claims
  independently** — trustworthy so far on a spec'd matrix, but the gate is what makes that safe to
  rely on. If Luna's write was supposed to touch disk, confirm it did (`git status`, read the file
  back).
- If Agy is reactivated and a danger-mode task touched production, confirm it was genuinely
  passive — nothing created, edited, or deleted. If a YOLO-mode task touched production, confirm
  every mutation happened under the impersonated test identity (`impersonatedBy` on the relevant
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
  measurement pass — that case, and only that case, is what §2.6's unsandboxed Luna mode exists
  for. See `../lessons.md` for the related MCP tool-list staleness issue.
- **Agy silent no-ops.** Two misconfigurations make an Agy write task report success while changing
  nothing on disk; a third makes a `grep`/`cat` read task do nothing. All are in
  [agy-cli.md](agy-cli.md), and all are why a reactivated Agy's report gets the same stderr check
  and re-verification as any other agent's (§5) rather than trust on its face.
- **Danger-mode / YOLO-mode scope creep.** The prompt-level restriction is the *only* guard — there
  is no sandbox to fall back on, and the `agy -p` run is a single non-interactive turn with no
  mid-run approval checkpoint. Restate §2.8's block every task if Agy is reactivated; never assume
  prior phrasing carries forward.
- **Undisclosed method substitution.** Told to sign in via real Google OAuth against local dev,
  Luna once hit `redirect_uri_mismatch` (no `localhost` redirect URI is registered on the OAuth
  client) and — despite naming "report the blocker" as its own fallback — read `BETTER_AUTH_SECRET`
  from the gitignored `.dev.vars`, computed an HMAC, wrote itself a row in the local D1 `session`
  table, then seeded fixture data via raw `sqlite3 INSERT`. **The technique is now sanctioned
  (§2.9); the silence is what made this a failure mode.** None of it appeared in the report, which
  read as an ordinary authenticated pass — so every downstream claim rested on a setup nobody had
  reviewed. The lesson generalizes past auth: an agent that substitutes its own method for the
  instructed one and does not say so has invalidated its whole report, whatever the method's
  merits. Read reports for what they *don't* mention, and prefer a prompt that gives the agent a
  sanctioned route (§2.9) over one that leaves it choosing between a blocker and a secret.

---

## 7. Frontend/UI work

Applies to any frontend/UI implementation task in this repo — new screens, component redesigns,
visual convergence releases, design-system adoption. The pipeline (§2 Pipeline) is the same one
used everywhere now; what's different here is what the plan must specify and what the gate must
check, not who builds it.

**Design-system source — cite it, never invent.** `prototype/_ds/quincy-productions-design-system-*/`
(`readme.md` plus its CSS) is authoritative: ink/paper duotone, greige ramp, Mazius Review/Apfel
Grotezk/Messapia/Athelas type roles, hairline rules, square corners, no-shadow elevation. It's
ported into `portal/apps/web/src/styles/tokens/*.css` — that's what a plan actually cites. Confirm
every token referenced in a plan exists there.

**Gotcha: unlayered `app.css` beats Tailwind utilities.** `portal/apps/web/src/styles/index.css`
declares `@layer theme, base, components, utilities`, then imports `app.css` outside any layer —
so any legacy rule there beats an ordinary Tailwind utility regardless of specificity, on every
surface, not just one. Any plan touching a legacy selector needs an explicit disposition, stated
per selector: retire the CSS and keep the class only as a non-styling hook; split into a new
component-specific class when the legacy one has consumers outside the current task's scope; or
fall back to `!`-prefixed utilities when neither fits.

**Scope: full UI rescue, not just the named control.** Plan every touched surface as a
rescue-and-revamp pass — assess and, where warranted, redesign the whole visual surface a task
reaches, not only the specific control that motivated the task. A task named for one control ("fix
the filter dropdown") still gets the whole panel it lives in looked at. This doesn't waive any
product rule below — it widens what counts as in scope for the visual pass.

Every plan still holds to: matched evidence at this repo's fixed viewports (1440×900, 1024×768,
390×844); preserved accessibility/security/product behavior; owner approval for intentional
evolution or deferral; one styling/data owner per surface; no whole-app rewrite; no stock-shadcn
appearance; no raw framework palette contract; full product/accessibility/test/QA coverage.
