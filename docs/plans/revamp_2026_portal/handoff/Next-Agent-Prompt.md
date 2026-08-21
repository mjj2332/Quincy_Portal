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

Do not load the archive unless auditing historical decisions.

## Approved direction

- Tailwind CSS v4 + shadcn target UI platform.
- Quincy brand remains authoritative.
- One coordinated revamp, implemented through tracer bullets.
- Keep path-based deep links.
- Restore automatic freshness without browser reload.
- Asynchronous comments/feedback only; no chat/presence requirement.
- No external managed messaging/feed/notification/Kanban vendor.
- Cloudflare infrastructure is acceptable.
- Quincy owns discussion, notification and Kanban domain data/rules.
- Current project Kanban card is a project and reuses project discussion.

## Your first task

Run TB0 planning only:

- re-check current head and repository facts;
- run/document baseline verification;
- resolve pending owner decisions;
- draft D-16/D-17 and implementation/PRD amendments;
- create a repository-native TB1 implementation plan;
- take it through `docs/Subagent-Orchestration.md`;
- do not install dependencies or modify product source before plan approval.

## Critical invariants

- Implementation only under `portal/`.
- `prototype/` is reference-only.
- Do not weaken auth/capability/audit rules.
- Keep direct/open-new-tab project links.
- No cross-project cache leakage.
- Background refresh cannot destroy unsaved drafts or active interactions.
- Subtask due values remain exactly `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, optional time, literal Sydney wall-clock.
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
