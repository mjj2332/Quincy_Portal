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
| RV-D13 | Every active assigned editor, including the actor, receives a mandatory durable in-app notification for the approved registry of project changes, including checklist, project-comment and collection changes. | Approved requirement | TB4A must define a finite, versioned event registry and durable recipient fan-out rather than interpreting “all changes” as every database write. Email is an additional channel under its approved reliability/preference contract. |
| RV-D14 | Add one project due date/time and allow zero, one or multiple configurable advance reminder offsets from the collaboration pane. | Approved requirement | Presets include one day, four hours and one hour; users may choose any subset, and the implementation must safely supersede reminders when the deadline changes. |
| RV-D15 | Show the project due date/time on Kanban cards and remove the card-level RAW count. | Approved requirement | TB4A changes card metadata only; RAW counts elsewhere and Kanban ordering/sort semantics stay unchanged unless separately approved. |

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
| RV-P15 | Editor roster mutations | Use dedicated idempotent add/remove editor operations with an expected membership version or equivalent guard. | Avoids concurrent lost updates from sending a stale full editor list and removes only the editor role when a user holds multiple project roles. |
| RV-P16 | Reminder representation | Store shared project reminder rules as unique positive lead-time offsets, normalized to integer minutes; provide 1 day, 4 hour and 1 hour presets plus a bounded custom number/unit control. | Directly supports one or multiple user-selected reminders without treating them as a recurring frequency. |
| RV-P17 | Project deadline scheduling | Persist a canonical deadline instant plus explicit display timezone and versioned reminder occurrences; scan due occurrences every minute and emit them through the TB4 outbox. | Editable D1 schedules are easier to cancel/reschedule/recover than one long-lived Workflow per reminder and can meet a time-critical minute-level contract. |
| RV-P18 | Editor-wide event scope | Maintain a finite, versioned registry of user-visible project events; emit one summary for a bulk import/job rather than one event per internal row or asset. | Satisfies the broad notification outcome while keeping volume, deduplication and copy testable. |
| RV-P19 | Recipient timing | Include the actor in mandatory in-app delivery, select only memberships created no later than the event, recheck active editor membership at delivery, and do not backfill delivered history when an editor is newly assigned. | Preserves the user's every-editor guarantee, prevents content delivery after access removal and keeps queued-event eligibility deterministic. |

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
- Who may change the editor roster, project deadline and reminder rules: current `editProject`/admin capability only (recommended) or a broader collaborator role?
- Which timezone defines project deadline entry/display, and must it always be the studio timezone or selectable per project?
- What reminder delivery tolerance is acceptable for time-critical work? A one-minute scan and delivery within two minutes is the proposed starting contract.
- What optional email policy accompanies mandatory in-app TB4A delivery, and what provider reliability/idempotency contract is available?
- Which exact user-visible mutations belong in the initial event registry, and what bulk-operation coalescing window is acceptable?
- Should a newly assigned editor receive events that were created but not delivered before assignment? The proposed rule excludes them by event time; delivered history is never backfilled.

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

After owner review, add at least three approved decisions to `docs/Decision-Sheet.md`:

- **D-16 — Frontend UI platform and design convergence:** Tailwind v4 + shadcn, incremental; Quincy design system authoritative; prototype used as the visual/flow reference with documented deviations.
- **D-17 — Collaboration/freshness/Kanban ownership:** Quincy-owned domain data on Cloudflare; asynchronous refresh; no external managed platform; Kanban ordering corrected before interaction modernization.
- **D-18 — Project coordination, deadlines and editor notifications:** collaboration-pane multi-editor assignment; one project deadline with multiple lead-time reminders; durable editor-wide notifications for an approved event registry; Kanban due metadata replacing the card RAW count.

Do not silently modify D-15. D-15 still correctly selects React 18 + TypeScript + Vite SPA.
