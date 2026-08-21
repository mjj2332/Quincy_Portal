# TB0 — Integrated Architecture, Decisions and Baseline

**User-visible change:** none

## Goal

Turn the revamp package into approved repository decisions, a matched prototype/current design baseline, a classified drift register and a current-main-aware implementation roadmap before dependencies or product code change.

## Required work

- Re-read current `main`, authority docs, todo, lessons and orchestration policy.
- Run the full pre-change gate.
- Capture matched prototype and current-production screenshots using equivalent content at approved desktop, collaboration-panel and phone widths where each surface exists.
- Create the design-convergence drift register from [the convergence contract](../core/11-Design-Convergence.md).
- Classify material differences as conforming, intentional evolution, required platform/accessibility change, unwanted drift, or unassessed.
- Record current bundle/CSS output.
- Resolve pending choices in the decision register.
- Record that Kanban ordering correction (TB5A) precedes interaction modernization (TB5B); decide whether the detailed priority/manual/date semantics are settled in TB0 or explicitly deferred to TB5A.
- Add/approve D-16 and D-17.
- Amend Implementation Plan and PRD.
- Update AGENTS/CLAUDE identically.
- Add an accurate todo umbrella entry.
- Create and review the TB1 implementation plan.

## Required decisions

- Base UI or Radix.
- Preflight policy.
- shadcn style/base color/icons/prefix.
- browser support for Tailwind v4.
- the design-convergence viewport/surface baseline and deviation-approval owner.
- TanStack Query acceptance for TB2.
- first discussion feature set.
- Queue/outbox direction.
- proposed Kanban canonical-order default or explicit deferral to TB5A.
- dnd-kit direction for TB5B after TB5A.

## Acceptance

- Authority documents agree.
- Baseline is green or failures are documented.
- Matched prototype/current evidence and a reviewable drift register exist.
- Every known material difference in the sampled surfaces is classified; “unassessed” items have an owner/follow-up.
- The roadmap and authority updates do not promise to preserve current Kanban ordering semantics.
- TB5A and TB5B have separate scope and dependency.
- No production source/dependency changes.
- TB1 plan passes the required review pipeline.

## Stop condition

Do not initialize Tailwind/shadcn, add packages, or begin Kanban interaction work before the decisions and applicable plans are approved.
