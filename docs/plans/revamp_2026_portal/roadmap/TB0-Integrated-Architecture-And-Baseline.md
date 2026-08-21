# TB0 — Integrated Architecture, Decisions and Baseline

**User-visible change:** none

## Goal

Turn the revamp package into approved repository decisions and a current-main-aware implementation roadmap before dependencies or product code change.

## Required work

- Re-read current `main`, authority docs, todo, lessons and orchestration policy.
- Run the full pre-change gate.
- Record current bundle/CSS output and representative screenshots.
- Resolve pending choices in the decision register.
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
- TanStack Query acceptance for TB2.
- first discussion feature set.
- Queue/outbox direction.
- dnd-kit board direction.

## Acceptance

- Authority documents agree.
- Baseline is green or failures are documented.
- No production source/dependency changes.
- TB1 plan passes the required review pipeline.

## Stop condition

Do not initialize Tailwind/shadcn or add packages before the decisions and plan are approved.
