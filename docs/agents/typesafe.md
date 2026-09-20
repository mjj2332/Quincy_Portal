# TypeSafe — a development tool for agents

TypeSafe's Jev model returns a typed **verdict** — a yes/no probability (Noul), one option of a
set (Choice), or a graded level (Score) — in about 350 ms. An agent uses it for a narrow judgment
over text it already holds, and keeps its own reasoning for everything else.

**Scope: the agent's own workflow.** TypeSafe lives in scratchpad scripts and agent sessions.
`portal/` stays free of it — no SDK, no API call, no key (owner decision, 2026-09-20).

## The three verdicts

Reach for TypeSafe when the work is one of these; each is one request per item.

1. **Finding triage** — a diff reviewer (Sol, `/code-review`) returned a list of findings and the
   orchestrator must decide whether another build round is owed.
   - Choice `reach`: `honest_mistake` (an ordinary edit could hit it) · `sabotage_only` (needs a
     deliberate bypass) · `test_gap` (production code is right, the test proves too little).
   - Noul `blocks_merge`.
   - State: the finding's text plus the reviewer's severity. Only `honest_mistake` findings block.
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

A verdict is **advice**. Act on it at confidence ≥ 0.9 (Noul ≥ 0.9 or ≤ 0.1); below that, decide
yourself and say so. Verify a verdict the same way you verify any agent's report.

## Calling it

- Claude Code: invoke the `typesafe:typesafe-ai` skill; it carries the question-design guidance.
- Any other agent: `POST https://api.typesafe.ai/v1/systemone`, body
  `{ state, model: "jev-latest", questions }`. The live contract is at
  `https://docs.typesafe.ai/llms.txt` (append `.md` to any page path for Markdown).
- The key is `TYPESAFE_API_KEY` in the shell environment. Read it as `process.env` / `$TYPESAFE_API_KEY`
  inside the request; it stays out of files, logs, and output.
- Scripts and results live in the session scratchpad.

## What may be sent

Review findings, test output, spec text, and code excerpts. Client data, addresses, booking text,
and the contents of `.dev.vars` / `.env*` / `.mcp.json` stay local.

## Known weak spot

Closed-vocabulary comparisons — street-type abbreviations, enum spellings — scored a false match at
0.76–0.81 in the 2026-09-20 experiments. Use a lookup table for those.
