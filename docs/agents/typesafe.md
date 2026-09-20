# TypeSafe — a development tool for agents

TypeSafe's Jev model returns a typed **verdict** — a yes/no probability (Noul), one option of a
set (Choice), or a graded level (Score) — in about 350 ms. Any agent may reach for a verdict
whenever one helps, and keeps its own reasoning for everything else.

**Scope: the agent's own workflow.** TypeSafe lives in scratchpad scripts and agent sessions.
`portal/` stays free of it — no SDK, no API call, no key (owner decision, 2026-09-20).

## When a verdict fits

The shape, not a fixed list: **a narrow judgment over text you already hold, where the answer is
one of a few named outcomes you can write down in advance.** Sorting a pile, deciding which of two
paths a case takes, grading one dimension, checking one claim against its evidence — these fit.
Reach for one whenever you would otherwise eyeball a batch by hand or hand-code a keyword rule.

Judgments that need to fetch evidence, hold a plan, or explain themselves stay yours. So does
anything where you cannot name the outcomes before asking.

A verdict is **advice**. Act on it at confidence ≥ 0.9 (Noul ≥ 0.9 or ≤ 0.1); below that, decide
yourself and say so. Verify a verdict as you verify any agent's report, and say in your own report
where one shaped a decision.

Volume is where it pays: a batch of findings, every test in a failing run, each file in a diff.
One judgment you could make by reading the text is usually faster to just make.

## Worked examples

These three are proven in this repo. Treat them as patterns to copy, not the boundary.

1. **Finding triage** — a diff reviewer (Sol, `/code-review`) returned findings and the
   orchestrator must decide whether another build round is owed.
   - Choice `reach`: `honest_mistake` (an ordinary edit could hit it) · `sabotage_only` (needs a
     deliberate bypass) · `test_gap` (production code is right, the test proves too little).
   - Noul `blocks_merge`. State: the finding's text plus the reviewer's severity. Only
     `honest_mistake` findings block.
2. **Test-failure triage** — a test failed, or failed once in N runs.
   - Choice `cause`: `missing_wait` (the DOM shows the *previous* state — loading, old rows) ·
     `wrong_final_state` (the DOM settled on something incorrect — a product bug) · `environment`
     (timeout, port, missing file).
   - State: the assertion message and the printed DOM or value. `wrong_final_state` goes to
     deep-reasoner; `missing_wait` goes to fast-worker with a wait-for-terminal-state fix.
3. **Task routing** — a written spec is ready and the builder is not obvious.
   - Choice `builder`: `fast_worker` (mechanical, every decision already made) · `deep_reasoner`
     (a design choice, an unexplained failure, or a tradeoff remains).
   - State: the spec text.

Other shapes that fit this repo's work, untested so far: scoring a lessons entry for whether it
still holds; deciding whether a spec answers a reviewer's finding; ranking issues against a stated
goal; checking whether a commit message describes its diff; grading a doc paragraph for staleness.
Design a question for the case in front of you rather than bending it into one of the above.

## Calling it

- Claude Code: invoke the `typesafe:typesafe-ai` skill; it carries the question-design guidance.
- Any other agent: `POST https://api.typesafe.ai/v1/systemone`, body
  `{ state, model: "jev-latest", questions }`. The live contract is at
  `https://docs.typesafe.ai/llms.txt` (append `.md` to any page path for Markdown).
- Ask every independent question about one piece of state in a single request; they run in
  parallel and cannot see each other's answers.
- The key is `TYPESAFE_API_KEY` in the shell environment. Read it as `process.env` / `$TYPESAFE_API_KEY`
  inside the request; it stays out of files, logs, and output.
- Scripts and results live in the session scratchpad.

## What may be sent

Repo text: review findings, test output, spec and issue text, code excerpts, docs. Client data,
addresses, booking text, and the contents of `.dev.vars` / `.env*` / `.mcp.json` stay local.

## Known weak spot

Closed-vocabulary comparisons — street-type abbreviations, enum spellings — scored a false match at
0.76–0.81 in the 2026-09-20 experiments. Use a lookup table for those.

Record a new pattern that earns its place, or one that misfires, in `docs/lessons.md`.
