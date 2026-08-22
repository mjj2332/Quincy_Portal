# Quincy Portal Revamp — High-Level Brief

**Status:** Revised owner/planning brief; decisions settled in the proposal package, authority promotion still pending  
**Revised:** 2026-08-22  
**Baseline:** `main` at `8bcb48245a727b048053bd3653cf07f3ad99b780`  
**Detailed documentation:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

## Purpose

Converge Quincy Portal toward its approved design system and prototype intent while modernizing its runtime, UI platform, data freshness, collaboration, operational notifications, project coordination, and existing Kanban board without losing the working product, deep links, security boundaries, or Cloudflare-native deployment model.

The work is an incremental program, not a rewrite.

## Program outcomes

1. Upgrade the production Vite SPA from React 18.3.1 to the latest stable pinned React 19.2 patch in an isolated release.
2. Establish Tailwind CSS v4 and source-owned shadcn components as implementation tools for Quincy design convergence.
3. Restore route-safe automatic data freshness while preserving drafts and active interactions.
4. Keep project discussion and the notice board asynchronous and Quincy-owned.
5. Make notification delivery durable through a D1 outbox and Cloudflare Queue.
6. Make the Project Workspace left rail the canonical project-level coordination surface.
7. Correct Stage and Kanban ordering semantics before modernizing drag interactions.
8. Migrate remaining UI surfaces only after the foundations are proven.

## Canonical coordination model

Project-level operational metadata belongs in the **Project Workspace left rail**:

- Stage;
- Deadline and reminder rules;
- Photographers;
- Editors.

The **Collaboration panel** remains focused on:

- project checklist/subtasks;
- project comments/discussion;
- related task-level collaboration.

The same project-level mutation control must not be duplicated permanently across both surfaces.

### Team controls

Photographers and Editors are independent rows. Each shows a compact adaptive roster and opens an anchored searchable multi-select picker. Changes apply immediately through role-specific idempotent operations. Existing cross-role eligibility remains:

- Photographer slot: active Photographers, Editors, and Admins.
- Editor slot: active Editors and Admins.

A person may hold both project roles. Removing one role never removes the other. Removing the final role may atomically clear checklist assignments, with a warning and count before confirmation.

`editProject` remains the mutation capability for team assignments and deadline configuration. Create Project retains initial assignment. Routine team selectors retire from Edit Project after rail parity is accepted, while a rollback path remains during rollout.

### Stage controls

A new `moveProjectStage` capability is introduced and initially granted to Admins and Editors. The left-rail picker and every Kanban movement path share one guarded Stage command.

System-stage progression is fixed semantically:

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

Configurable display order does not redefine automation. Editors see the neutral **Editing** presentation for `editing_autohdr`; Admins may see its configured internal label. Admins and Editors may enter or exit that Stage, but doing so changes Stage only—it does not start, cancel, retire, or delete AutoHDR work.

Normal one-step forward moves are immediate, except AutoHDR entry/exit. Backward moves, skipped steps, delivered transitions, and AutoHDR entry/exit require the approved confirmation treatment. Archived projects are read-only. A project already on an inactive Stage remains intelligible and may move to an active destination.

Global pipeline label and active/inactive management remains in `Admin → Pipeline`. Global ordering becomes developer-managed in TB0B: ordinary Admin Up/Down controls and the matching self-service endpoint are removed. Stage creation, deletion, and generic workflow-builder behavior remain deferred.

### Deadline controls

A project has one nullable project Deadline, separate from shoot date/time and checklist due values. The left rail presents one combined Deadline/Reminders block and one transactional editor.

Approved contract:

- `Australia/Sydney` studio timezone;
- explicit handling of daylight-saving gaps and repeated local times;
- presets for 1 day, 4 hours, and 1 hour, with none preselected;
- custom whole-number minutes/hours/days from 1 minute to 30 days;
- at most eight unique normalized offsets;
- one Due-now event at the Deadline;
- every-minute scan targeting mandatory in-app delivery within two minutes;
- default-on reminder email with a per-user global opt-out;
- versioned schedules, stale-occurrence suppression, and explicit conflict handling;
- pending reminders are superseded when a project is delivered or archived and do not silently resume later.

Kanban cards show the Deadline/overdue state and no longer show the card-level RAW count. No Deadline-based sort or automatic Stage movement is introduced.

## Runtime and UI platform

### React 19.2

TB0A upgrades only production `portal/` to the latest stable React `19.2.x` patch at implementation time, pinned exactly with matching React DOM and compatible type packages. As of this revision the latest stable React package is `19.2.8`.

The release is compatibility-only:

- keep `createRoot`, StrictMode, the modern JSX transform, TypeScript, Vite, and the SPA architecture;
- use reviewed official codemods and direct fixes for remaining type/runtime issues;
- do not adopt React Compiler, SSR, Server Components, Actions, `Activity`, or broad refactors as collateral work;
- update supporting packages only when a demonstrated compatibility blocker requires the minimum change.

### Tailwind/shadcn

TB1 begins after TB0A and TB0B are live. The first setup uses:

- Tailwind CSS v4 with Preflight disabled initially;
- shadcn with Base UI and the Sera style scaffold;
- Lucide icons;
- CSS-variable theming mapped from existing Quincy semantic tokens;
- app-local `components/ui` and `components/quincy` ownership;
- one existing ProjectFields Client section as the bounded proof;
- no dark mode.

The Quincy design system is visual authority. The prototype is a visual/flow reference, never an application-architecture template. Every material difference is classified and supported by matched evidence.

## Data, discussion, and notifications

- Keep the typed custom router. Adopt TanStack Query incrementally, beginning with Project detail plus active collection assets.
- Same-browser changes use narrow `BroadcastChannel` invalidation; focus/reconnect and bounded polling remain the cross-session safety net.
- TB3 keeps one flat project discussion stream, existing rich text/mentions and author-only mutation, adds server-owned read state, and uses an adapter over the existing tables.
- TB4 proves a D1 outbox and Cloudflare Queue with project-comment mention as the first event. It includes a delivery ledger, retry, DLQ, recovery scan, and minimal Admin replay/status operations.
- TB4C adds immutable structured activity plus a finite Editor-wide registry. In-app delivery is mandatory for eligible assigned Editors; broad event email is off by default.
- Email delivery records an explicit `unknown` state when provider acceptance is ambiguous; automatic retries do not risk hidden duplicates in that state.

## Kanban contract

TB5A is renamed **Project Stage and Kanban Ordering Contract**.

- `boardPosition` is the sole persisted manual order within a Stage.
- Existing data is normalized once to preserve the current visible board order.
- Priority is metadata and an optional view-only sort where `1` is highest; null is last.
- Shoot-date sorts remain view-only.
- Rail and non-drag Stage moves append to the target Stage; a Kanban drag may specify exact neighbours.
- Pure position reorders do not notify Editors, though they remain audited/activity-capable.

TB5B then replaces native HTML5 dragging with dnd-kit and supplies pointer, touch, keyboard, and non-drag movement against the accepted TB5A command.

## Revised sequence

```text
TB0   Integrated decisions, authority proposal, baseline and drift register
TB0A  React 19.2 runtime upgrade
TB0B  Pipeline configuration boundary
TB1   Tailwind v4 + shadcn foundation
TB2   Route-safe Project Workspace freshness
TB3   Project discussion v2 and server-owned read state
TB4   Notification outbox + Cloudflare Queue
TB4A  Project Workspace assignment rail
TB4B  Project Deadline/reminders + Kanban due metadata
TB4C  Editor-wide project-change registry
TB5A  Project Stage and Kanban ordering contract
TB5B  Kanban interaction modernization
TB6   URL-addressable project-card detail
TB7   Notice-board synchronization migration
TB8   Evidence-driven surface-by-surface convergence
```

## Authority proposal

After a separate owner approval, TB0 should promote:

- **D-16:** UI platform and design convergence.
- **D-17:** Quincy-owned collaboration, freshness, pipeline, and Kanban architecture.
- **D-18:** Project Workspace coordination, Deadline, and Editor notifications.
- **D-19:** React 19.2 runtime baseline, superseding only the React-major portion of D-15.

Implementation Plan amendments should be A8 through A12. This package revision does not modify those authority files.
