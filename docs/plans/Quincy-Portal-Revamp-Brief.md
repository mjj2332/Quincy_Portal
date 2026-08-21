# Quincy Portal Revamp — High-Level Brief

**Status:** Owner and planning-agent brief  
**Prepared:** 2026-08-21  
**Detailed documentation:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

## Purpose

Modernize Quincy Portal's UI and collaboration architecture without losing its working product, brand, deep links, security boundaries, or Cloudflare-native deployment model.

The program combines five related concerns under one north-star design:

1. Tailwind CSS v4 and shadcn migration.
2. Route-safe automatic data freshness.
3. Asynchronous project discussions and the staff notice board.
4. Reliable in-app/email notifications on Cloudflare.
5. Modernization of the existing project Kanban board.

The implementation remains a sequence of small, independently deployable tracer bullets. It is not a single rewrite.

## User-approved boundaries

- Keep `portal/` as the only production implementation area.
- Keep `prototype/` reference-only.
- Keep React 18, Vite, Hono, D1, R2, Workers, Tiptap, and existing security rules unless a separate decision changes them.
- Use Tailwind v4 and source-owned shadcn components for migrated ordinary UI.
- Preserve Quincy's ink-on-warm-paper brand, fonts, semantic signals, hairlines, restrained radius, and low elevation.
- Do not add an external managed comments/chat/feed/Kanban platform.
- Cloudflare-managed infrastructure is acceptable.
- Do not build Slack-like chat, typing indicators, presence, or WebSockets by default.
- Keep deep, shareable routes such as `/projects/:projectId`.
- Restore automatic refresh while a user stays on a route.

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
TB0  Integrated decisions, documentation, baseline and approved plan
TB1  Thin Tailwind v4 + shadcn foundation on one existing form section
TB2  Route-safe Project Workspace freshness
TB3  Project Discussion v2 and server-side read state
TB4  D1 notification outbox + Cloudflare Queues
TB5  Existing Kanban modernization
TB6  Project-card detail + shared discussion/activity
TB7  Notice-board migration
TB8  Wider UI migration and legacy cleanup
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
- Whether the existing project board should keep native drag temporarily or move directly to dnd-kit.
- Whether MUI X remains necessary for a specialized date/time control after the shadcn-first proof.

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

## Success criteria

The program succeeds when:

- multiple project tabs remain isolated and deep-linkable;
- visible pages receive relevant server changes without a manual reload;
- ordinary UI is built from Quincy-customized Tailwind/shadcn components;
- comments, notice posts and notifications have reliable unread/delivery behavior;
- the Kanban board has accessible and conflict-safe movement;
- Cloudflare remains infrastructure, while Quincy owns the domain model and data;
- legacy CSS and duplicated fetch/mutation logic shrink only as proven surfaces migrate;
- every release remains independently testable, reviewable and reversible.

## Immediate next action

Approve or amend the [decision register](./revamp_2026_portal/core/01-Decision-Register.md), then take [TB0](./revamp_2026_portal/roadmap/TB0-Integrated-Architecture-And-Baseline.md) through the repository's plan-review process.
