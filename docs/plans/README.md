# Settled plans

A plan the session has synthesised (Opus + Codex, `docs/subagents/Subagent-Orchestration.md` §4)
lives here as `docs/plans/<issue>.md`, or on the issue as a comment (`gh issue comment <n>
--body-file <plan.md>`) — never only in a tmp scratchpad, which the next session cannot find. Start
from `docs/subagents/templates/plan-brief.md`; a build brief points at the file by path. Once the
issue closes, the plan is history, not authority: the code, its tests and the ADRs win.
