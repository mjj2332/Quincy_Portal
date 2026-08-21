# Revamp Decision Register

**Status:** Mixed — user-approved directions plus proposed implementation defaults  
**Last updated:** 2026-08-21

This register prevents research conclusions, owner choices and agent recommendations from being mistaken for one another.

## A. User-approved directions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D01 | Adopt Tailwind CSS v4 and shadcn as the target UI direction. | Approved direction | Older “no Tailwind / custom CSS only” handoffs are superseded. Existing Quincy tokens and brand remain authoritative. |
| RV-D02 | Plan the UI, freshness, comments, notifications and Kanban as one coordinated revamp. | Approved direction | Cross-cutting contracts are designed together. |
| RV-D03 | Implement the revamp through tracer bullets, not one large rewrite. | Approved direction | Each release has one primary outcome, a rollback boundary and its own reviewed plan. |
| RV-D04 | Do not depend on a separate managed messaging, social-feed, notification-orchestration, Trello or Kanban vendor. | Approved direction | Liveblocks, Stream, Knock, TalkJS, Trello-as-backend and similar vendor-owned stores are out. |
| RV-D05 | Cloudflare infrastructure and services are acceptable dependencies. | Approved direction | Workers, D1, R2, Queues, Cron, Workflows and related Cloudflare primitives may be used. |
| RV-D06 | Quincy handles asynchronous project feedback, not real-time chat. | Approved direction | No requirement for typing, presence or WebSocket chat. Slack/Google Chat remain the realtime tools. |
| RV-D07 | Keep path-based, deep-linkable URLs. | Approved direction | Multiple projects can be open in multiple tabs; links can target a project/sub-page. |
| RV-D08 | Restore automatic data freshness without browser reload. | Approved requirement | Route-scoped data must refetch/invalidate safely while preserving drafts and interaction state. |
| RV-D09 | Quincy owns collaboration/Kanban domain data and rules. | Approved direction | D1 is the leading authoritative store; vendor-specific domain models are avoided. |
| RV-D10 | Make design convergence—not framework adoption—the UI outcome. | Approved direction | The Quincy design system is the visual authority, the prototype is the visual/flow reference, and material deviations require classification and evidence. |
| RV-D11 | Correct Kanban ordering semantics before modernizing its interaction engine. | Approved direction | Existing priority/`boardPosition`/shoot-date behavior is not grandfathered; TB5A must establish one understandable contract before TB5B adds dnd-kit/freshness. |

## B. Proposed defaults requiring approval in TB0

| ID | Proposed decision | Recommendation | Why |
|---|---|---|---|
| RV-P01 | shadcn primitive base | Start with Base UI; retain Radix as an alternative after a focused overlay proof. | Base UI is the current shadcn default for new projects; Quincy has no large Radix investment. |
| RV-P02 | Tailwind Preflight | Disable initially; preserve the existing Quincy base layer. | Avoid unrelated global heading/list/border/image regressions during the first slice. |
| RV-P03 | shadcn location | `portal/apps/web/src/components/ui/` | One production web app exists; a shared workspace is premature. |
| RV-P04 | Theme model | CSS variables mapped to existing Quincy semantic tokens. | Keeps brand values centralized and avoids raw palette classes. |
| RV-P05 | Server-state layer | Add `@tanstack/react-query` first on Project Workspace freshness. | The app now has real invalidation, polling, route isolation, retry and focus-refresh pressure. |
| RV-P06 | Router | Keep the typed custom router initially. | The router already supports path parsing/history/deep links; data freshness is the current defect. |
| RV-P07 | Discussion migration | Add a common discussion service/model through an adapter before removing current tables. | Preserves production while proving project and notice-board requirements. |
| RV-P08 | Notification reliability | D1 transactional outbox + Cloudflare Queue + DLQ + recovery scan. | Removes direct request-path delivery fragility while staying Cloudflare-native. |
| RV-P09 | Kanban interaction | Modernize the existing project board with dnd-kit first; compare Pragmatic DnD only if a measured limitation appears. | dnd-kit is already installed and tested elsewhere in Quincy. |
| RV-P10 | Kanban comments | Reuse project discussion because a current Kanban card is a project. | Avoid duplicate card/project comments. |
| RV-P11 | Date/time UI | Try shadcn-first; permit narrow MUI X fallback only if accessible minute-precise behavior is otherwise disproportionate. | Tailwind/shadcn is now the UI platform; MUI is no longer pre-approved globally. |
| RV-P12 | Dark mode | Exclude from the revamp. | Prevent unrequested design and maintenance scope. |
| RV-P13 | Icon policy | Use one approved icon library for new shadcn components, migrate existing icons only with their surfaces. | Avoid collateral icon rewrite. |
| RV-P14 | Kanban ordering default | Make `boardPosition` the sole persisted manual order; treat priority as metadata unless the user selects an explicit Priority sort; keep shoot-date modes view-only. | Removes the current mismatch between display-only grouping and the flat persisted order, and prevents metadata edits from secretly rearranging manual order. |

## C. Product choices still open

These are product questions, not implementation details:

- Are project discussions one chronological stream or multiple named threads?
- Are replies one level or arbitrarily nested?
- Are reactions required in the first release?
- Can a project member subscribe to all activity, replies/mentions only, mentions only, or mute?
- Does the notice board allow replies, or only top-level posts?
- Do notices support pinning, priority, expiry or required acknowledgement?
- Are comment/card attachments in the first program or later?
- Should project activity and human discussion appear in one visual timeline?
- What delay is acceptable for visible updates: 15, 30 or 60 seconds?
- Should same-browser tabs invalidate each other immediately through `BroadcastChannel`?
- Should photographers retain collaboration access outside their full workspace stage visibility exactly as today?
- Is project priority metadata-only, an explicit optional sort, or an ordering command? TB5A must choose one meaning rather than combining them implicitly.
- When a project changes stage, should its manual position append to the target column, retain a relative rank, or use another explicit insertion rule?

TB0 must either decide these or explicitly defer them to the relevant tracer bullet.

## D. Superseded guidance

The archived 2026-08-20 handoff contains decisions that are no longer active:

- do not migrate to Tailwind;
- custom CSS remains the only styling system;
- MUI X is the selected first proof;
- Radix should be evaluated as a separate pre-shadcn primitive strategy;
- TanStack Query remains deferred;
- UI refactoring is scoped separately from collaboration/Kanban freshness.

Those files are retained under `archive/` only for historical reasoning.

## E. Repository decision mapping

After owner review, add at least two approved decisions to `docs/Decision-Sheet.md`:

- **D-16 — Frontend UI platform and design convergence:** Tailwind v4 + shadcn, incremental; Quincy design system authoritative; prototype used as the visual/flow reference with documented deviations.
- **D-17 — Collaboration/freshness/Kanban ownership:** Quincy-owned domain data on Cloudflare; asynchronous refresh; no external managed platform; Kanban ordering corrected before interaction modernization.

Do not silently modify D-15. D-15 still correctly selects React 18 + TypeScript + Vite SPA.
