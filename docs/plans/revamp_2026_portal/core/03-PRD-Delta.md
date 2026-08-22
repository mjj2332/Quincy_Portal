# PRD Delta — Runtime, UI, Freshness, Coordination, Collaboration and Kanban

**Status:** Proposed product requirements for later promotion into `docs/PRD.md`  
**Baseline:** `main` at `8bcb48245a727b048053bd3653cf07f3ad99b780`  
**Implementation details remain in architecture and tracer-bullet documents.**

## 1. Product objective

Quincy Portal must remain a secure, deep-linkable, Cloudflare-native production application while upgrading to React 19.2, converging toward the Quincy design system, refreshing server data automatically, coordinating projects from the Project Workspace left rail, delivering operational notifications durably, and making the existing Kanban board understandable and accessible.

## 2. Runtime and UI outcomes

- Production runs the latest stable pinned React `19.2.x` patch through an isolated compatibility release.
- The Vite SPA, TypeScript, StrictMode, typed custom router, and Cloudflare deployment remain.
- React Compiler, SSR, Server Components, and product-level React feature refactors are not part of the runtime upgrade.
- Migrated ordinary controls use Quincy-owned Tailwind v4/shadcn source.
- Base UI/Sera/Lucide and semantic CSS variables provide the initial scaffold; Quincy tokens and design language remain authoritative.
- Tailwind Preflight is disabled initially.
- Material visual differences are classified and evidenced at approved desktop, compact, and phone viewports.
- Dark mode is excluded.

## 3. Workspace and freshness outcomes

- Stable URLs support direct navigation, Back/Forward, and multiple projects in separate tabs.
- Every server-backed screen defines route/resource query identity, stale/fresh behavior, focus/reconnect policy, polling policy, invalidation, cancellation, and draft-preservation behavior.
- Same-browser tabs receive narrow mutation invalidation; another session observes ordinary changes within the bounded polling target.
- Background refresh never destroys an unsaved editor, open picker/dialog, Lightbox position, selection, scroll, filter, or drag.
- Access removal clears inaccessible cached content and does not retry permanently forbidden resources indefinitely.

## 4. Canonical Project Workspace coordination

### 4.1 Surface ownership

The Project Workspace left rail is canonical for:

- Stage;
- project Deadline and reminder rules;
- Photographers;
- Editors.

The Collaboration panel remains canonical for:

- project checklist/subtasks;
- project comments/discussion;
- task-level collaboration.

Project-level mutation controls are not duplicated permanently across both surfaces.

### 4.2 Rail hierarchy and responsive behavior

The rail uses:

1. project header/status/address/location;
2. Production: Stage, Shoot, Deadline;
3. Team: Photographers, Editors;
4. Client: Agency, Agent;
5. Collections/Dropbox.

At phone width it becomes a full-width Project Overview above workspace content. Stage and Deadline remain immediately visible; Team/Client may use compact disclosures. Pickers become viewport-contained popovers or bottom sheets without moving ownership into Collaboration.

A stage-hidden collaborator receives a limited read-only coordination summary—presentation-safe Stage, Deadline/overdue/next reminder, and both rosters—without full workspace, client, media, Dropbox, or AutoHDR diagnostic data.

### 4.3 Team assignment

- Photographers and Editors are separate rows with adaptive visible names/initials and full accessible names.
- Pickers are anchored, searchable by name/email/role, keyboard accessible, and support multiple selections.
- Each person's selection applies immediately through a role-specific idempotent operation.
- Independent changes do not block one another; a stale membership-cycle removal returns conflict rather than deleting a new assignment cycle.
- Photographer eligibility remains active Photographer/Editor/Admin.
- Editor eligibility remains active Editor/Admin.
- One person may hold both roles; removing one role preserves the other.
- Inactive assigned users remain visible and removable but cannot be newly assigned.
- Removing the final non-admin project role warns about and atomically clears affected checklist assignments.
- A new assignment produces one targeted role-specific notification; removal is audit-only for the removed user.
- `editProject` governs team mutation.
- Create Project retains initial assignment; routine Edit Project team controls retire after rail parity.

### 4.4 Stage mutation

- Introduce `moveProjectStage`, initially granted to Admins and Editors.
- Rail, drag, keyboard, and non-drag movement share one guarded command.
- Stable semantic progression is:

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

- Configurable display order never redefines workflow semantics.
- A normal one-step public-stage forward move is immediate.
- Confirm backward transitions, skipped forward transitions, entering/leaving delivered, and entering/leaving `editing_autohdr`.
- Editors see neutral **Editing** presentation; Admins may see the internal configured label.
- Manual AutoHDR Stage change never starts, cancels, retires, or deletes integration work.
- Expected-state conflict returns authoritative state and does not automatically retry.
- Archived projects are read-only.
- The current inactive Stage remains intelligible; authorized users may leave it for an active destination but cannot select another inactive destination.
- Rail/non-drag Stage movement appends to target bottom; positional Kanban drag may specify neighbours.
- Entering/leaving delivered never publishes or revokes artifacts.

### 4.5 Global pipeline boundary

- Admin retains Stage label and active/inactive management.
- Ordinary Admin global ordering is removed from UI and API in TB0B.
- Global order changes are developer-managed through reviewed migrations/scripts.
- Stage creation/deletion and generic workflow-builder behavior remain deferred.

## 5. Deadline and reminder requirements

- A project has one nullable project Deadline, independent from shoot date/time window and checklist due values.
- Deadline and reminder offsets are edited together in one transactional left-rail control.
- The canonical timezone is `Australia/Sydney`, visibly labelled.
- Persist local civil value, IANA zone, selected UTC offset/fold, canonical UTC instant, and schedule version.
- Reject nonexistent daylight-saving times; ambiguous times require an explicit earlier/later choice.
- Offer 1-day, 4-hour, and 1-hour presets with none selected by default.
- Permit at most eight unique positive offsets normalized to integer minutes; custom values use whole-number minutes/hours/days from 1 minute to 30 days.
- Saving a Deadline always materializes a Due-now occurrence.
- A past Deadline is allowed, renders overdue, skips elapsed advance offsets, and produces one current-version Due-now/overdue event.
- Scan due occurrences every minute and target mandatory in-app creation within two minutes.
- A new schedule version supersedes old pending occurrences. The same offset may fire again after a real reschedule.
- Save conflicts preserve the local draft and show authoritative values; no silent merge or last-write-wins.
- Current active Editor membership cycles are resolved at fire/delivery time; unassigned Admins are excluded.
- Deadline/rule changes emit one semantic broad in-app event per save.
- Reminder email is default-on only after a per-user global Notification Preferences opt-out is available.
- Delivered or archived projects retain Deadline metadata but supersede pending occurrences. Leaving delivered/restoring archived does not silently resume them.
- Kanban cards show absolute Deadline/overdue text and omit only the card-level RAW count.
- Deadline never changes Stage, Priority, `boardPosition`, or sort mode.

## 6. Discussion and read state

- Project discussion remains one flat newest-first stream in TB3.
- Preserve rich text, mentions, author-only edit/delete, cursor pagination, and collaboration-only access.
- Add server-owned per-user read state.
- Mark read only after a successful fresh fetch while the discussion is visibly presented; hidden background fetches do not clear unread state.
- Drafts survive refresh.
- Use an adapter over current storage; do not backfill into a speculative universal discussion schema in TB3.

## 7. Structured activity and notifications

### 7.1 Activity

- Each semantic project operation creates one immutable structured activity event with actor, project, occurrence time, versioned safe payload, and deep-link context.
- Activity is distinct from the security/audit log and recipient-specific notification rows.
- Internal retries and delivery bookkeeping create no activity.

### 7.2 Durable delivery

- Record notification intent durably with the domain mutation.
- Use Cloudflare Queue, idempotent recipient/channel delivery rows, recovery scan, and DLQ.
- Queue/email failure never rolls back a successful domain mutation.
- Mandatory in-app insertion is unique/idempotent.
- Definitive transient email failures may retry.
- Ambiguous provider acceptance becomes `unknown` and is not automatically retried.
- Minimal Admin operations expose pending/stuck/DLQ/failed/unknown outcomes and safe replay/discard.

### 7.3 Assigned-Editor registry

- Every approved event reaches each active eligible assigned Editor, including an eligible actor, through one mandatory in-app row.
- The membership cycle must begin no later than event occurrence and remain active at delivery.
- Removal/deactivation suppresses pending content; remove/re-add cannot receive older-cycle events; no history backfill.
- Unassigned Admins are not appended.
- Existing targeted mention and assignment events remain distinct.
- A newly assigned Editor receives the targeted assignment row but not a duplicate broad roster row.
- Pure Kanban/checklist reorders do not notify; Stage and Priority changes do.
- Comment create/delete notify. Repeated edits to the same comment by one actor coalesce within five minutes.
- One collection/background operation produces one summary, not one row per asset/internal write.
- Broad event email is off by default. Targeted mentions, targeted assignments, and Deadline reminders are default-on subject to user preferences.
- Broad copy is minimal: actor, project, category/outcome, safe link; no broad comment excerpt, filename, project note, client contact, Dropbox path, or provider diagnostic.

## 8. Kanban requirements

- Card = project; column = Stage.
- `boardPosition` is the sole persisted manual order in a Stage.
- At cutover, normalize positions once to preserve the current visible Board order.
- Priority is metadata. Optional Priority view sorts `1` highest through `10`, null last; ties use `boardPosition`, then ID.
- Shoot-date views remain temporary and write nothing.
- Priority edits never rewrite manual order.
- Manual reorder controls appear only in Board order.
- All Stage movement uses the `moveProjectStage` command.
- Board movement is conflict-safe and returns authoritative state.
- TB5B uses dnd-kit with pointer, touch, keyboard, and non-drag movement, a dedicated handle, DragOverlay, and active-drag refresh reconciliation.
- Direct project link and native open-new-tab behavior remain.
- Pure position reorders are audited but do not create broad notifications.

## 9. Project-card detail and notice board

- TB6 opens a URL-addressable desktop side sheet and phone full-screen presentation.
- Back/Forward, refresh, deep links, and open-new-tab remain predictable.
- Separate Overview, Activity, and Discussion views; do not mix operational events and human comments into one undifferentiated feed.
- Provide a canonical link to `/projects/:projectId`.
- TB7 preserves top-level notice posts, rich text, mentions, and author-only rules while moving read state to D1 and using query refresh plus durable mention delivery.
- Replies, pinning, priority, expiry, and acknowledgement remain separate later product work.

## 10. Product-level acceptance

The program succeeds when staff can:

1. Open multiple projects in separate tabs without data leakage.
2. Observe relevant external changes without a browser reload and without losing local work.
3. Coordinate Stage, Deadline, Photographers, and Editors from the canonical left rail.
4. Receive deterministic conflict feedback rather than silently overwriting newer membership, schedule, Stage, or board state.
5. Rely on current Editor membership cycles for Deadline and project-change delivery.
6. Use a board whose visible manual order matches persisted order and whose temporary sorts write nothing.
7. Move projects accessibly by pointer, touch, keyboard, and non-drag controls.
8. Receive durable, deduplicated operational notifications with bounded noise and privacy-safe copy.
9. Use project discussion/read state across devices.
10. Recognize every migrated surface as Quincy through evidence-backed design convergence rather than stock framework appearance.
11. Continue using production coherently after any accepted tracer bullet if later roadmap work stops.
