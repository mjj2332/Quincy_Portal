# Revamp Decision Register

**Status:** Owner decisions settled in the proposal package; repository authority promotion pending  
**Last updated:** 2026-08-22  
**Baseline:** `main` at `8bcb48245a727b048053bd3653cf07f3ad99b780`

This register separates owner-approved planning direction from future implementation evidence. A settled direction is not live until its tracer bullet is planned, built, verified, committed, and deployed.

## A. Program and platform decisions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D01 | Use one coordinated revamp delivered through independently coherent tracer bullets. | Approved direction | No wholesale rewrite; every release has one primary outcome and rollback boundary. |
| RV-D02 | Keep `portal/` as the only production implementation and `prototype/` as reference-only. | Approved direction | Never extend or copy prototype application structure. |
| RV-D03 | Upgrade production to the latest stable pinned React `19.2.x` patch in TB0A. | Approved direction | React/React DOM versions match exactly; D-19 will supersede only the React-major portion of D-15. |
| RV-D04 | Keep the Vite SPA, TypeScript, `createRoot`, StrictMode, typed custom router, and Cloudflare Worker asset-serving architecture. | Approved direction | No SSR, Server Components, framework migration, or router replacement as collateral work. |
| RV-D05 | React TB0A is compatibility-only. | Approved direction | No React Compiler, `Activity`, Actions/form refactor, `useEffectEvent` sweep, ref-as-prop rewrite, or product redesign in the runtime release. |
| RV-D06 | Adopt Tailwind CSS v4 and source-owned shadcn components after TB0A/TB0B. | Approved direction | Tailwind/shadcn are implementation tools, not visual authority. |
| RV-D07 | Use Base UI, Sera scaffold, Lucide, CSS variables, app-local component ownership, and disabled Preflight for TB1. | Approved direction | Quincy tokens and design language replace stock generated appearance. |
| RV-D08 | Accept Tailwind v4's official browser floor. | Approved direction | Chrome/Chromium 111+, Safari 16.4+, Firefox 128+; no unsupported legacy-browser promise. |
| RV-D09 | Exclude dark mode. | Approved direction | Reopen only through a separate product decision. |
| RV-D10 | Use fixed visual baselines at 1440×900, 1024×768, and 390×844, plus relevant overlay/state evidence. | Approved direction | Material deviations require classification and owner disposition. |

## B. Freshness, discussion, and delivery decisions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D11 | Keep path-based deep links and adopt TanStack Query incrementally in TB2. | Approved direction | First migration is Project detail plus active collection assets; route and collection variables belong in query keys. |
| RV-D12 | Use narrow same-browser `BroadcastChannel` invalidation plus focus/reconnect refresh and bounded polling. | Approved direction | Target approximately two seconds for same-browser tabs and 30 seconds for another session, without WebSockets. |
| RV-D13 | Keep one flat project discussion stream in TB3. | Approved direction | Existing rich text, mentions, author-only edit/delete, newest-first order, and cursor pagination remain; replies/reactions/attachments/subscriptions are deferred. |
| RV-D14 | Use an adapter over current project-comment storage and add server-owned read state. | Approved direction | Common storage is reconsidered only when a second real consumer justifies it. |
| RV-D15 | Use a D1 outbox, Cloudflare Queue, recipient/channel delivery ledger, recovery scan, and DLQ. | Approved direction | Domain writes do not depend on successful Queue/email delivery. |
| RV-D16 | Project-comment mention is the first TB4 durable event. | Approved direction | Exactly one old/new semantic producer is authoritative during cutover. |
| RV-D17 | Record ambiguous email acceptance as `unknown` and do not retry automatically. | Approved direction | Admin/support replay warns that duplicate email is possible; mandatory in-app delivery is unaffected. |
| RV-D18 | Add minimal Admin delivery operations in TB4. | Approved direction | Expose pending/stuck/DLQ/failed/unknown state plus safe replay/discard without sensitive content. |

## C. Project Workspace coordination decisions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D19 | The Project Workspace left rail is the canonical project-level coordination surface. | Approved requirement | Stage, Deadline/Reminders, Photographers, and Editors live there; Collaboration remains checklist/subtasks plus discussion. |
| RV-D20 | The rail uses operational-first grouping. | Approved requirement | Header → Production (Stage, Shoot, Deadline) → Team (Photographers, Editors) → Client (Agency, Agent) → Collections/Dropbox. |
| RV-D21 | Photographer and Editor controls are independent rows with adaptive roster display and searchable anchored multi-select pickers. | Approved requirement | One/two names render directly; larger rosters show the first two plus `+N`; full names remain accessible. |
| RV-D22 | Assignment changes apply immediately per person. | Approved requirement | Each delta has its own optimistic/pending/error state; the picker remains open. |
| RV-D23 | Preserve current cross-role assignment eligibility. | Approved requirement | Photographer slot: active Photographer/Editor/Admin. Editor slot: active Editor/Admin. A user may hold both roles. |
| RV-D24 | Use explicit idempotent role routes and membership-cycle guards. | Approved direction | Stale removal cannot delete a newly re-added membership; different people/roles remain independent. |
| RV-D25 | Retain `editProject` for Photographer, Editor, Deadline, and Reminder mutations. | Approved direction | Collaboration/workspace visibility does not confer write access. |
| RV-D26 | Create Project keeps initial assignments; routine team selectors retire from Edit Project after rail parity. | Approved direction | Temporary rollback capability may re-enable them during rollout. |
| RV-D27 | Inactive assigned users remain visible and removable but cannot be newly selected. | Approved requirement | Stored roster is never hidden or silently rewritten. |
| RV-D28 | Removing a person's final non-admin project role may atomically clear checklist assignments after a warning with the affected count. | Approved requirement | Retaining another role or active Admin status preserves checklist assignments. |
| RV-D29 | Newly assigned users receive the targeted role-specific assignment notification; removal is audit-only. | Approved requirement | TB4C later notifies remaining Editors of the roster change without duplicating the new assignee's targeted row. |
| RV-D30 | Stage-hidden collaboration-only users receive a limited read-only coordination summary outside Collaboration. | Approved requirement | Show presentation-safe Stage, Deadline/next reminder, and both rosters; expose no media/client/Dropbox/AutoHDR diagnostics. |

## D. Stage and pipeline decisions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D31 | Introduce `moveProjectStage`, initially granted to Admins and Editors. | Approved direction | The rail, Kanban drag, and non-drag movement share one guarded Stage command. |
| RV-D32 | Preserve fixed semantic system-stage progression. | Approved direction | `awaiting_raw → raw_review → editing_autohdr → edited_review → delivered`; display order cannot redefine workflow semantics. |
| RV-D33 | Admins and Editors may manually enter or exit `editing_autohdr`. | Approved requirement | The change is Stage-only; it never starts, cancels, retires, or deletes AutoHDR work. Editors see neutral **Editing** copy. |
| RV-D34 | Apply semantic confirmation rules. | Approved requirement | Confirm backward moves, skipped forward steps, delivered entry/exit, and dedicated AutoHDR entry/exit; normal one-step public-stage forward moves are immediate. |
| RV-D35 | Use expected Stage/revision conflicts with no automatic retry. | Approved direction | A `409` shows authoritative state and keeps the picker open. |
| RV-D36 | Rail and non-drag Stage moves append to target bottom; positional Kanban drag may supply exact neighbours. | Approved direction | Priority is preserved as metadata and does not determine insertion. |
| RV-D37 | Archived projects are read-only. | Approved requirement | Restore before changing Stage, team, Deadline, or Reminder rules. |
| RV-D38 | A project on an inactive Stage remains visible and may move to an active destination. | Approved requirement | Inactive Stages cannot be newly selected after leaving them. |
| RV-D39 | Entering/leaving `delivered` is Stage-only. | Approved requirement | It never publishes, revokes, creates, or deletes delivery artifacts. |
| RV-D40 | Global label and active/inactive management stays in Admin; global ordering becomes developer-managed. | Approved direction | TB0B removes Admin Up/Down controls and the ordinary self-service move endpoint. Stage creation/deletion and generic workflow building remain deferred. |

## E. Deadline and reminder decisions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D41 | Use one combined left-rail Deadline/Reminders block and editor. | Approved requirement | Deadline and offsets are one transactional versioned schedule. |
| RV-D42 | Use `Australia/Sydney` as the explicit studio timezone. | Approved requirement | Reject DST gaps; require earlier/later selection for repeated local times; persist local value, zone, offset/fold, and UTC instant. |
| RV-D43 | Provide 1-day, 4-hour, and 1-hour presets with none preselected. | Approved requirement | A project may use zero reminders. |
| RV-D44 | Permit custom whole-number minutes/hours/days from 1 minute to 30 days, maximum eight unique normalized offsets. | Approved requirement | Equivalent offsets deduplicate. |
| RV-D45 | Scan every minute and target mandatory in-app delivery within two minutes. | Approved requirement | Exact-to-the-second delivery is not promised. |
| RV-D46 | Every Deadline produces a Due-now event. | Approved requirement | A past Deadline produces one current-version Due-now/overdue event and skips elapsed advance offsets. |
| RV-D47 | Schedule changes create one broad semantic event. | Approved requirement | Deadline/rule edits do not emit one event per offset. |
| RV-D48 | Future reminder recipients are resolved from active Editor membership cycles at fire/delivery time. | Approved requirement | Unassigned Admins are excluded; remove/re-add cannot receive older-cycle events. |
| RV-D49 | Rescheduling creates a new version whose future offsets may fire again. | Approved requirement | Historical notifications remain; stale occurrences never fire. |
| RV-D50 | Deadline reminder email is default-on with a per-user global opt-out. | Approved requirement | The Notification Preferences page ships before default-on email is enabled; mandatory in-app rows cannot be disabled. |
| RV-D51 | Delivery or archival supersedes all pending occurrences without clearing metadata. | Approved requirement | Leaving delivered/restoring archived does not silently resume reminders; the coordinator must confirm/save a new schedule version. |
| RV-D52 | Kanban cards show absolute Deadline/overdue metadata and omit the card-level RAW count. | Approved requirement | No empty placeholder, Deadline sort, priority rewrite, or automatic Stage movement. |

## F. Activity, registry, and privacy decisions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D53 | Persist one immutable structured activity event per semantic project operation. | Approved direction | Security audit remains separate; notifications derive/reference activity rather than recipient inbox rows. |
| RV-D54 | Mandatory Editor-wide in-app delivery uses a finite versioned registry. | Approved requirement | Event/source/actor/copy/deep-link/recipient/coalescing/producer ownership are explicit. |
| RV-D55 | Exclude pure Kanban/checklist reorder from broad notifications. | Approved requirement | Stage and Priority changes notify; position-only changes remain audited/activity-capable. |
| RV-D56 | Comment create/delete notify; repeated same-actor edits coalesce within five minutes. | Approved requirement | Broad comment copy contains no body excerpt; targeted mention policy remains separate. |
| RV-D57 | One user action or background job produces one collection/delivery summary. | Approved requirement | No event per asset, rendition, cache write, or retry bookkeeping. |
| RV-D58 | Newly assigned Editor receives one targeted assignment row, not a duplicate broad roster row. | Approved requirement | Existing eligible Editors receive the broad roster-change event; removed users receive no content-bearing removal row. |
| RV-D59 | Broad registry email is off by default. | Approved requirement | Default-on email is limited to targeted mentions, targeted assignments, and Deadline reminders. |
| RV-D60 | Use minimal operational notification copy. | Approved requirement | Include actor, project, category/outcome, link; checklist title allowed; no broad comment body, filenames, notes, client contacts, Dropbox paths, or provider diagnostics. |
| RV-D61 | Membership cycle must begin by event occurrence and still exist at delivery. | Approved requirement | Removal suppresses queued delivery; no history backfill; unassigned Admins are excluded. |

## G. Kanban and later-surface decisions

| ID | Decision | Status | Consequence |
|---|---|---|---|
| RV-D62 | `boardPosition` is the sole persisted manual order. | Approved direction | Priority and shoot-date sorts are view-only and never rewrite manual order. |
| RV-D63 | Normalize existing positions once to preserve current visible Board order. | Approved direction | Cutover does not cause an unrelated card reshuffle. |
| RV-D64 | Priority view sorts `1` highest through `10`, null last; ties use `boardPosition` then ID. | Approved requirement | Drag/reorder controls are disabled outside Board order. |
| RV-D65 | Use dnd-kit first in TB5B. | Approved direction | Compare another engine only after a measured blocker; never run two production engines. |
| RV-D66 | TB6 uses a URL-addressable responsive sheet with separate Overview, Activity, and Discussion views. | Approved requirement | Preserve Back/Forward, deep links, new-tab behavior, and a canonical workspace link. |
| RV-D67 | TB7 migrates read state/freshness/reliable mention delivery only. | Approved direction | Replies, pinning, priority, expiry, and acknowledgement require separate later decisions. |
| RV-D68 | TB8 ordering is evidence-driven. | Approved direction | One reviewed surface release at a time; no final wholesale CSS rewrite. |

## H. Proposed repository authority mapping

After a separate owner approval, TB0 should propose:

- **D-16 — Frontend UI platform and design convergence.**
- **D-17 — Quincy-owned collaboration, freshness, pipeline, and Kanban architecture.**
- **D-18 — Project Workspace coordination, Deadline, and Editor notifications.**
- **D-19 — React 19.2 runtime baseline**, explicitly superseding only the React-major portion of D-15.

Implementation Plan amendments:

- **A8:** UI platform and design convergence.
- **A9:** route-aware server-state freshness.
- **A10:** discussions, durable notifications, pipeline semantics, and Kanban.
- **A11:** canonical rail coordination, roster deltas, Stage capability, Deadline/reminders, and Editor registry.
- **A12:** React 19.2 compatibility-only runtime upgrade.

These authority documents are intentionally unchanged by this package revision.

## I. Superseded active-package guidance

The following statements are superseded wherever they appear in historical material:

- Editor assignment belongs in the Collaboration panel.
- Project Deadline/Reminder editing belongs in the Collaboration panel.
- Stage mutation remains under `editProject`.
- `editing_autohdr` is not a manual destination.
- React 19 is a revamp non-goal.
- Admin Up/Down pipeline ordering remains ordinary self-service.
- Priority grouping is part of authoritative Board order.
- TB4A covers Editors only.
- TB5A is only a numeric ordering repair.
