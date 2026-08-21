# Next-Agent Handoff — Quincy Portal Revamp

You are taking over planning for the private repository `mjj2332/Quincy_Portal`.

## Read first

From current `main`:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/Decision-Sheet.md`
4. `docs/Implementation-Plan.md`
5. `docs/PRD.md`
6. `docs/todo.md`
7. `docs/lessons.md`
8. `docs/Subagent-Orchestration.md`

Then read only these package files initially:

1. `docs/plans/Quincy-Portal-Revamp-Brief.md`
2. `docs/plans/revamp_2026_portal/core/01-Decision-Register.md`
3. `docs/plans/revamp_2026_portal/core/02-Current-State-Audit.md`
4. `docs/plans/revamp_2026_portal/roadmap/TB0-Integrated-Architecture-And-Baseline.md`
5. `docs/plans/revamp_2026_portal/core/10-Repository-Document-Update-Map.md`

If the active task is project coordination, deadline/reminders, editor-wide change delivery or the Kanban deadline/RAW metadata change, also read:

6. `docs/plans/revamp_2026_portal/core/03-PRD-Delta.md`
7. `docs/plans/revamp_2026_portal/core/06-Discussions-And-Notice-Board.md`
8. `docs/plans/revamp_2026_portal/core/07-Notifications-On-Cloudflare.md`
9. `docs/plans/revamp_2026_portal/research/Cloudflare-Native-Architecture-Research.md`
10. `docs/plans/revamp_2026_portal/roadmap/TB4A-Project-Coordination-Deadline-And-Editor-Notifications.md`

Read Kanban architecture/TB5A/TB5B only when the active work touches the card metadata or subsequent board slices.

Do not load the archive unless auditing historical decisions.

## Approved direction

- Tailwind CSS v4 + shadcn target UI platform.
- Design convergence is the UI outcome: Quincy design system authoritative, prototype visual/flow reference, material deviations classified.
- One coordinated revamp, implemented through tracer bullets.
- Keep path-based deep links.
- Restore automatic freshness without browser reload.
- Asynchronous comments/feedback only; no chat/presence requirement.
- No external managed messaging/feed/notification/Kanban vendor.
- Cloudflare infrastructure is acceptable.
- Quincy owns discussion, notification and Kanban domain data/rules.
- Current project Kanban card is a project and reuses project discussion.
- Kanban ordering semantics are corrected in TB5A before dnd-kit/freshness work in TB5B; current priority/position/sort behavior is not grandfathered.
- Authorized users assign/remove multiple editors directly in the collaboration pane using the existing membership model.
- Every active assigned editor, including the actor, receives a mandatory durable in-app notification for the approved finite registry of project changes; email is additional under its reliability/preference contract.
- One project due date/time supports zero or multiple advance reminders; Kanban cards show it and omit the card-level RAW count.
- TB4A follows the TB4 outbox proof and precedes TB5A/TB5B.

## Your first task

Run TB0 planning only:

- re-check current head and repository facts;
- run/document baseline verification;
- capture matched prototype/current screenshots and create the design-convergence drift register;
- resolve pending owner decisions;
- draft D-16/D-17/D-18 and implementation/PRD amendments with design convergence, the TB4A coordination contract and the TB5A-before-TB5B dependency;
- create a repository-native TB1 implementation plan;
- take it through `docs/Subagent-Orchestration.md`;
- do not install dependencies or modify product source before plan approval.

## Critical invariants

- Implementation only under `portal/`.
- `prototype/` is a visual/flow reference only; never copy its application structure.
- Current production behavior is not visual authority merely because it is live.
- Do not weaken auth/capability/audit rules.
- Keep direct/open-new-tab project links.
- No cross-project cache leakage.
- Background refresh cannot destroy unsaved drafts or active interactions.
- Subtask due values remain exactly `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, optional time, literal Sydney wall-clock.
- Project deadline remains a separate instant/timezone contract; never reuse or reinterpret `shootDate`, `timeWindow` or the subtask due literal.
- Editor roster mutations preserve other project roles, current capability checks and audit behavior.
- “All project changes” means the approved versioned event registry with explicit coalescing, not every storage write.
- There is no staging environment.
- Production mutation requires human authorization.

## Full verification

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

An implementing agent's self-report is not verification. Follow the independent review/gate.
