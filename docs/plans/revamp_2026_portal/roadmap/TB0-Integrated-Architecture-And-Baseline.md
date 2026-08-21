# TB0 — Integrated Architecture, Decisions and Baseline

**User-visible change:** none  
**Decision gate:** approve the umbrella direction and TB0-owned defaults; explicitly defer later product choices to their owning tracer bullets.

## Goal

Turn the revamp package into approved repository decisions, a matched prototype/current design baseline, a classified drift register and a current-main-aware implementation roadmap before dependencies or product code change.

## Required work

- Re-read current `main`, authority docs, todo and lessons.
- Run the full pre-change gate.
- Capture matched prototype and current-production screenshots using equivalent content at approved desktop, collaboration-panel and phone widths where each surface exists.
- Create the design-convergence drift register from [the convergence contract](../core/11-Design-Convergence.md).
- Classify material differences as conforming, intentional evolution, required platform/accessibility change, unwanted drift or unassessed.
- Record current bundle/CSS output.
- Approve or amend the TB0-gated rows in the [decision register](../core/01-Decision-Register.md).
- For every later-slice choice, record the owning bullet and explicit deferral; do not decide feature details prematurely.
- Record that TB4A editor assignment, TB4B deadline/reminders and TB4C editor-wide alerts are separate release gates after TB4.
- Record that Kanban ordering correction (TB5A) precedes interaction modernization (TB5B); decide only the umbrella direction here and defer exact ordering semantics to TB5A if needed.
- Add/approve D-16, D-17 and D-18.
- Amend Implementation Plan and PRD.
- Update AGENTS/CLAUDE identically.
- Add an accurate todo umbrella entry.
- Create and review the TB1 implementation plan.

## Decisions TB0 must settle

- Base UI or Radix for the first shadcn proof.
- Preflight policy.
- shadcn style/base color/icons/prefix and component location.
- supported browser floor for Tailwind v4.
- design-convergence viewport/surface baseline and deviation-approval owner.
- TanStack Query as the TB2 direction.
- typed custom-router retention.
- D1 outbox + Cloudflare Queue as the TB4 direction.
- Quincy-owned project discussion reuse for Kanban cards.
- dark-mode exclusion and icon policy.
- D-16/D-17/D-18 wording.

## Decisions TB0 records but may defer

| Owning bullet | Decision family |
|---|---|
| TB3 | Discussion threads/replies/reactions/subscriptions and photographer collaboration visibility. |
| TB4 | Email-provider ambiguity/idempotency and minimum replay/administration surface. |
| TB4A | Editor-roster mutation capability. |
| TB4B | Deadline timezone, delivery tolerance, custom reminder bounds, past-offset policy and reminder-email default. |
| TB4C | Initial event registry, noise/coalescing, optional email and queued-event eligibility. |
| TB5A | Priority/manual/date ordering semantics and target-stage insertion. |
| TB5B | Final DnD choice if the dnd-kit proof exposes a measured limitation. |
| TB6/TB7 | Card-detail/activity composition and notice-board feature choices. |

A deferral is complete only when the decision register names the owning bullet. “Resolve later” without an owner is not accepted.

## Acceptance

- Authority documents agree.
- Baseline is green or failures are documented.
- Matched prototype/current evidence and a reviewable drift register exist.
- Every known material difference in the sampled surfaces is classified; unassessed items have an owner/follow-up.
- All TB0-owned decisions are approved or amended.
- Every later product choice has an explicit owner/gate and remains visibly unapproved.
- The roadmap preserves separate TB4A/TB4B/TB4C release boundaries.
- TB5A and TB5B retain separate scope and dependency.
- No production source/dependency changes.
- TB1 plan passes the required review pipeline.

## Stop condition

Do not initialize Tailwind/shadcn, add packages or begin later tracer-bullet implementation before TB0 authority updates and the applicable per-bullet plan are approved.
