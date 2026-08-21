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
| RV-D12 | Assign or remove multiple project editors directly in the collaboration pane using an assignee-picker interaction comparable to checklist items. | Approved requirement | The Edit Project form is no longer required for routine editor roster changes; the existing multi-editor membership model remains authoritative. |
| RV-D13 | Every active assigned editor, including the actor, receives a mandatory durable in-app notification for the approved registry of project changes, including checklist, project-comment and collection changes. | Approved requirement | TB4C defines a finite, versioned event registry and durable recipient fan-out rather than interpreting “all changes” as every database write. Email is an additional channel under its approved reliability/preference contract. |
| RV-D14 | Add one project due date/time and allow zero, one or multiple configurable advance reminder offsets from the collaboration pane. | Approved requirement | TB4B provides presets for one day, four hours and one hour; users may choose any subset, and the implementation must safely supersede reminders when the deadline changes. |
| RV-D15 | Show the project due date/time on Kanban cards and remove the card-level RAW count. | Approved requirement | TB4B changes card metadata only; RAW counts elsewhere and Kanban ordering/sort semantics stay unchanged unless separately approved. |

## B. Proposed defaults and decision gates

A proposed default is not approved merely because it appears here. The named gate must either approve it or record an explicit deferral with an owner and later gate.

| ID | Proposed decision | Recommendation | Decision gate | Why |
|---|---|---|---|---|
| RV-P01 | shadcn primitive base | Start with Base UI; retain Radix as an alternative after a focused overlay proof. | TB0 | Base UI is the current shadcn default for new projects; Quincy has no large Radix investment. |
| RV-P02 | Tailwind Preflight | Disable initially; preserve the existing Quincy base layer. | TB0 | Avoid unrelated global heading/list/border/image regressions during the first slice. |
| RV-P03 | shadcn location | `portal/apps/web/src/components/ui/` | TB0 | One production web app exists; a shared workspace is premature. |
| RV-P04 | Theme model | CSS variables mapped to existing Quincy semantic tokens. | TB0 | Keeps brand values centralized and avoids raw palette classes. |
| RV-P05 | Server-state layer | Add `@tanstack/react-query` first on Project Workspace freshness. | TB0 direction; TB2 exact plan | The app now has real invalidation, polling, route isolation, retry and focus-refresh pressure. |
| RV-P06 | Router | Keep the typed custom router initially. | TB0 | The router already supports path parsing/history/deep links; data freshness is the current defect. |
| RV-P07 | Discussion migration | Add a common discussion service/model through an adapter before removing current tables. | TB3 | Preserves production while proving project and notice-board requirements. |
| RV-P08 | Notification reliability | D1 transactional outbox + Cloudflare Queue + DLQ + recovery scan. | TB0 direction; TB4 exact plan | Removes direct request-path delivery fragility while staying Cloudflare-native. |
| RV-P09 | Kanban interaction | Modernize the existing project board with dnd-kit first; compare Pragmatic DnD only if a measured limitation appears. | TB5B, after TB5A | dnd-kit is already installed and tested elsewhere in Quincy. |
| RV-P10 | Kanban comments | Reuse project discussion because a current Kanban card is a project. | TB0 direction; TB6 exact surface | Avoids duplicate card/project comments. |
| RV-P11 | Date/time UI | Try shadcn-first; permit a narrow MUI X fallback only if accessible minute-precise behavior is otherwise disproportionate. | TB1 component policy; TB4B proof | Tailwind/shadcn is now the UI platform; MUI is no longer pre-approved globally. |
| RV-P12 | Dark mode | Exclude from the revamp. | TB0 | Prevents unrequested design and maintenance scope. |
| RV-P13 | Icon policy | Use one approved icon library for new shadcn components; migrate existing icons only with their surfaces. | TB0 | Avoids collateral icon rewrite. |
| RV-P14 | Kanban ordering default | Make `boardPosition` the sole persisted manual order; treat priority as metadata unless the user selects an explicit Priority sort; keep shoot-date modes view-only. | TB5A | Removes the mismatch between display-only grouping and flat persisted order. |
| RV-P15 | Editor roster mutations | Use dedicated idempotent add/remove editor operations with an expected membership version or equivalent guard. | TB4A | Avoids concurrent lost updates from the existing stale full-list shape and removes only the editor role when a user holds multiple roles. |
| RV-P16 | Reminder representation | Store shared project reminder rules as unique positive lead-time offsets normalized to integer minutes; provide 1 day, 4 hour and 1 hour presets plus a bounded custom control. | TB4B | Supports multiple selected reminders without treating them as recurrence. |
| RV-P17 | Project deadline scheduling | Persist a canonical deadline instant plus explicit display timezone and versioned reminder occurrences; scan due occurrences every minute and emit through the TB4 outbox. | TB4B | Editable D1 schedules centralize cancellation, rescheduling and recovery. |
| RV-P18 | Editor-wide event scope | Maintain a finite, versioned registry of user-visible project events; emit one summary for a bulk import/job rather than one event per internal row or asset. | TB4C | Keeps volume, deduplication and copy testable while satisfying the broad outcome. |
| RV-P19 | Recipient timing | Include the actor when the actor is an assigned editor; select only editor memberships begun no later than the event; recheck active membership at delivery; do not backfill delivered history. | TB4C | Prevents delivery after access removal and keeps queued-event eligibility deterministic without silently adding unassigned admins. |

## C. Product choices still open

| Gate | Product choices |
|---|---|
| TB0 | Approved design-convergence viewports/surfaces and deviation owner; UI primitive/Preflight/icon policy; TanStack Query direction; outbox direction; router retention. |
| TB3 | One stream or named threads; reply depth; reactions; subscription levels; photographer collaboration access outside full workspace stage visibility. |
| TB4 | Email-provider idempotency/ambiguous-acceptance policy and the minimum administration/replay surface. |
| TB4A | Who may change the editor roster: current `editProject`/admin capability only (recommended) or a broader collaborator role. |
| TB4B | Studio-fixed or per-project timezone; reminder delivery tolerance; custom reminder bounds/rule cap; past-offset behavior; optional reminder email default. |
| TB4C | Exact initial event registry; copy and bulk coalescing; optional email policy; queued-event eligibility for a newly assigned editor. |
| TB5A | Whether priority is metadata-only, an explicit optional sort or an ordering command; target-column insertion rule after a stage move. |
| TB6 | Card-detail route/sheet/dialog behavior and whether system activity and human discussion are interleaved. |
| TB7 | Notice-board replies, pinning, priority, expiry and required acknowledgement. |
| Later/explicitly scoped | Comment/card attachment timing and policy; same-browser `BroadcastChannel`; exact visible-refresh delay if TB2 evidence does not settle it. |

TB0 must decide the TB0 rows, approve D-16/D-17/D-18 at the umbrella level, and record every later choice as an explicit deferral to its owning bullet. A later implementation plan must not inherit a proposed default as though TB0 had approved it.

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

After owner review, add at least three approved decisions to `docs/Decision-Sheet.md`:

- **D-16 — Frontend UI platform and design convergence:** Tailwind v4 + shadcn, incremental; Quincy design system authoritative; prototype used as the visual/flow reference with documented deviations.
- **D-17 — Collaboration/freshness/Kanban ownership:** Quincy-owned domain data on Cloudflare; asynchronous refresh; no external managed platform; Kanban ordering corrected before interaction modernization.
- **D-18 — Project coordination, deadlines and editor notifications:** collaboration-pane multi-editor assignment; one project deadline with multiple lead-time reminders; durable editor-wide notifications for an approved event registry; Kanban due metadata replacing the card RAW count.

Do not silently modify D-15. D-15 still correctly selects React 18 + TypeScript + Vite SPA.
