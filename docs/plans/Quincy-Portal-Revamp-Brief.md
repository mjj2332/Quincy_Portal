# Quincy Portal Revamp — High-Level Brief

**Status:** Owner and planning-agent brief  
**Prepared:** 2026-08-21  
**Detailed documentation:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

## Purpose

Converge Quincy Portal back toward its approved design system and original prototype intent while modernizing its UI and collaboration architecture without losing the working product, deep links, security boundaries, or Cloudflare-native deployment model.

The program combines six related concerns under one north-star design:

1. Design-system/prototype convergence through an incremental Tailwind CSS v4 and shadcn migration.
2. Route-safe automatic data freshness.
3. Asynchronous project discussions and the staff notice board.
4. Reliable in-app/email notifications on Cloudflare.
5. Time-critical project coordination: direct multi-editor assignment, project due date/time, configurable advance reminders and editor-wide change alerts.
6. Modernization of the existing project Kanban board.

The implementation remains a sequence of small, independently deployable tracer bullets. It is not a single rewrite.

## User-approved boundaries

- Keep `portal/` as the only production implementation area.
- Keep `prototype/` reference-only.
- Keep React 18, Vite, Hono, D1, R2, Workers, Tiptap, and existing security rules unless a separate decision changes them.
- Use Tailwind v4 and source-owned shadcn components for migrated ordinary UI.
- Treat the Quincy design system as the visual authority and the prototype as the visual/flow reference; do not copy prototype application structure.
- Preserve Quincy's ink-on-warm-paper brand, fonts, semantic signals, hairlines, restrained radius, and low elevation.
- Classify every material production/prototype difference as conforming, intentional evolution, required platform/accessibility change, unwanted drift, or unassessed.
- Do not add an external managed comments/chat/feed/Kanban platform.
- Cloudflare-managed infrastructure is acceptable.
- Do not build Slack-like chat, typing indicators, presence, or WebSockets by default.
- Keep deep, shareable routes such as `/projects/:projectId`.
- Restore automatic refresh while a user stays on a route.
- Let authorized users assign or remove multiple editors directly in the collaboration pane.
- Notify every active assigned editor, including the actor, through a mandatory durable in-app event for the approved registry of project changes; email remains an additional channel.
- Add one project-level due date/time with zero, one or multiple advance reminder offsets.
- Show due date/time on Kanban cards and remove only the card-level RAW count.

## Target architecture

```text
React 18 + Vite SPA
  ├── Custom typed route parser/history adapter
  ├── TanStack Query proposal for route-keyed server state
  ├── Tailwind CSS v4
  ├── shadcn source-owned components
  ├── Tiptap v3 for rich text and mentions
  ├── dnd-kit for sortable interactions
  └── Quincy feature modules
         │
         ▼
Hono on Cloudflare Workers
  ├── D1: authoritative relational state
  ├── R2: media and future discussion/card attachments
  ├── Queues: notification delivery, retry, DLQ
  ├── Cron: outbox recovery and periodic scans
  ├── Workflows: only long-lived multi-step jobs
  └── Email Service: transactional email behind an adapter
```

## Key product insight

The current Kanban card already represents a project. Therefore, “Kanban card comments” and “project comments” should not become duplicate systems. A project-card detail view can display the same project discussion and activity history.

A separate `kanban_card` discussion scope is needed only if Quincy later adds cards that are not projects.

## Why automatic refresh broke

Path-based routing is not inherently incompatible with automatic updates. The current router correctly tracks pathname/history and scopes `ProjectWorkspace` by project ID. The stale behavior comes from data lifecycle: several screens load once and then depend on local state or manual reload, while only some job/status surfaces poll.

The fix is route-keyed server-state behavior:

- include every route variable in query keys;
- refetch stale data on focus/reconnect;
- use bounded polling where useful;
- invalidate affected queries after mutations;
- cancel or ignore stale requests after route changes;
- preserve unsaved drafts, scroll, open editors, and drag state during background refresh.

## Recommended tracer-bullet order

```text
TB0  Integrated decisions, prototype/current visual baseline and approved plan
TB1  Thin Tailwind v4 + shadcn foundation on one existing form section
TB2  Route-safe Project Workspace freshness
TB3  Project Discussion v2 and server-side read state
TB4  D1 notification outbox + Cloudflare Queues
TB4A Project coordination, deadline/reminders and editor-wide change notifications
TB5A Kanban ordering-model correction
TB5B Kanban interaction/freshness modernization
TB6  Project-card detail + shared discussion/activity
TB7  Notice-board migration
TB8  Surface-by-surface design convergence and legacy cleanup
```

Do not finish the entire UI refactor before product work. Do not combine all bullets into one implementation. Build only the UI/data foundations required by the next real feature.

## Major open implementation decisions

The following are recommended but still require plan/owner approval:

- Base UI or Radix beneath shadcn; Base UI is the current default recommendation.
- Tailwind Preflight disabled initially or enabled from the first slice; disabled initially is recommended.
- TanStack Query as the server-state layer; recommended because current requirements now include background refresh, route isolation, invalidation, retry and stale-state coordination.
- Whether to generalize current comment tables immediately or migrate through an adapter first.
- Exact discussion features in v2: replies, reactions, subscriptions, pinning, attachments and acknowledgement.
- Exact polling intervals and whether same-browser `BroadcastChannel` invalidation is included.
- The canonical relationship between project priority, persisted manual order and temporary shoot-date views; the proposed default makes manual order the sole persisted order and priority metadata unless an explicit Priority sort is selected.
- After the ordering contract is corrected, whether the existing project board should keep native drag temporarily or move directly to dnd-kit.
- Whether MUI X remains necessary for a specialized date/time control after the shadcn-first proof.
- Which existing capability may assign editors and change the project deadline/reminder rules; retaining the current `editProject`/admin boundary is recommended.
- The project-deadline timezone contract and reminder delivery tolerance; a clearly labelled studio timezone with UTC scheduling and a one-minute scan is recommended.
- The finite event registry and batching rules that operationalize “all project changes” without emitting one alert per internal row or imported asset.
- The optional email-channel policy and whether a newly assigned editor receives already-queued events created before assignment; mandatory in-app delivery includes the actor.

## Non-goals

- No React 19 migration as collateral work.
- No router replacement solely because path-based routes exist.
- No realtime chat.
- No external collaboration/Kanban SaaS.
- No wholesale CSS conversion.
- No database table deletion before a verified additive migration.
- No dark mode unless separately approved.
- No backend authorization weakening.
- No change to the literal subtask due contract: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, Sydney wall-clock, optional time.
- No new deadline-based Kanban sort or change to project shoot date/time-window semantics unless separately approved.

## Success criteria

The program succeeds when:

- multiple project tabs remain isolated and deep-linkable;
- visible pages receive relevant server changes without a manual reload;
- ordinary UI is built from Quincy-customized Tailwind/shadcn components and passes the approved design-convergence checks against the design system and prototype reference;
- comments, notice posts and notifications have reliable unread/delivery behavior;
- editors can be assigned in context and receive deduplicated project-change and deadline reminders;
- project deadlines are distinct from shoot dates and checklist due values, survive rescheduling safely and appear on Kanban cards;
- the Kanban board has one understandable ordering contract, no invisible ordering side effects, and accessible conflict-safe movement;
- Cloudflare remains infrastructure, while Quincy owns the domain model and data;
- legacy CSS and duplicated fetch/mutation logic shrink only as proven surfaces migrate;
- every release remains independently testable, reviewable and reversible.

## Immediate next action

Approve or amend the [decision register](./revamp_2026_portal/core/01-Decision-Register.md), then take [TB0](./revamp_2026_portal/roadmap/TB0-Integrated-Architecture-And-Baseline.md) through the repository's plan-review process.
