# PRD Delta — UI, Freshness, Collaboration and Kanban

**Status:** Proposed product requirements to merge into `docs/PRD.md` after owner approval  
**Implementation details belong in the architecture and tracer-bullet documents, not the final PRD.**

## 1. Product objective

Quincy Portal must converge toward its approved design system and prototype intent while providing a consistent, deep-linkable and automatically refreshed workspace for project production, asynchronous feedback, operational notifications and project-stage Kanban management.

The revamp must preserve existing workflows while reducing the need to build and maintain one-off UI, comment, unread and notification mechanics.

## 2. User outcomes

### Staff workspace

- A user can open several projects in separate tabs using stable URLs.
- Each tab remains scoped to its project.
- Relevant server changes appear without a browser reload within an approved delay.
- Returning to a background tab refreshes stale data.
- Background refresh does not destroy unsaved drafts, editor state, lightbox position, selection, scroll or drag operations.

### Project discussion

- Authorized project participants can post structured asynchronous feedback.
- Existing rich-text formatting and mentions remain available.
- Users can see new feedback without reloading the browser.
- Read/unread state follows the user across browsers/devices.
- Edit/delete permissions and audits remain exact.
- Deep links can open the project and its collaboration surface.

### Staff notice board

- Staff can publish organization-wide notices.
- New notices and read state are synchronized server-side.
- The product can later support comments/replies, pinning, priority, expiry and acknowledgement without replacing the underlying discussion foundation.
- The notice board remains asynchronous and does not imitate realtime chat.

### Notifications

- In-app notification state is durable and user-specific.
- Mention, assignment, due and project-event notifications are idempotent.
- Email delivery is performed asynchronously and retried safely.
- Users can eventually choose categories/channels and mute appropriate project/discussion activity.
- Failed delivery is observable rather than silently lost.

### Kanban

- The existing project-stage board remains a first-class view of projects.
- Cards can be moved accessibly by pointer, touch and keyboard/non-drag controls.
- Movement persists safely and conflicts do not silently overwrite another user's newer change.
- The visible card order and authoritative persisted order follow one documented contract.
- A control must not report success while producing no visible effect or secretly changing manual order behind another sort mode.
- Board changes made elsewhere appear without a browser reload.
- A project card can expose project details, activity and the existing project discussion without creating duplicate comment storage.

### UI consistency

- Migrated ordinary controls use a shared, source-owned component layer.
- Quincy remains visually recognizable and does not adopt stock framework styling.
- The Quincy design system is the visual authority; the prototype is the visual/flow reference, not an application-architecture template.
- Material deviations from the reference are classified and approved rather than accumulating implicitly.
- Controls remain usable at desktop, collaboration-panel and phone widths.
- Accessibility is preserved or improved.

## 3. Functional requirements

### 3.1 Deep links and navigation

- Keep `/projects/:projectId` and support future nested routes where product value exists.
- Browser Back/Forward must remain functional.
- Internal links must preserve native open-in-new-tab/window behavior.
- Direct navigation after sign-in must return to the safe requested destination.

### 3.2 Automatic freshness

Every server-backed screen must define:

- a resource/query identity including all route parameters;
- a stale/fresh policy;
- a visible polling policy where needed;
- refetch-on-focus and reconnect behavior;
- mutation invalidation behavior;
- stale-request cancellation/ignore rules;
- a strategy for preserving local drafts and active interactions.

No user should need a full browser reload to observe ordinary project, board, comment, notice or notification changes.

### 3.3 Discussion content

- Continue using the shared validated rich-text document format.
- Preserve mention eligibility and normalized labels.
- Enforce content byte/length limits on client and server.
- Preserve author-only comment/post editing and deletion unless a new approved product decision changes it.
- Preserve project collaboration access separately from full stage-gated workspace access.

### 3.4 Read state

- Store read/unread state server-side per user and discussion/notice scope.
- Clearing local browser storage must not reset organizational read history.
- The UI may use optimistic marking, but the server is authoritative.

### 3.5 Notification delivery

- Domain mutations and notification intent must be recorded durably.
- Delivery must be idempotent.
- Queue failure and email failure must not roll back a successful comment or board move.
- Retries must not create duplicate notifications or duplicate email sends.
- Persistent failures must be visible to an administrator or support workflow.

### 3.6 Kanban movement

- Project stage remains the column identity.
- TB5A must define and approve the canonical relationship between priority, manual `boardPosition`, stage movement and temporary sort modes; current behavior is not presumed correct.
- Visible order and persisted manual order must not disagree through display-only grouping.
- Priority or date-view changes must not secretly rewrite manual order unless the approved product contract explicitly says they are ordering commands.
- Every drag action must have a keyboard/non-drag alternative.
- The API must reject stale/conflicting moves safely.
- Temporary date/priority views must remain clearly distinct from manual board ordering, and manual reorder controls appear only when they can have an immediate visible effect.

### 3.7 Attachments

When approved:

- attachment metadata is stored in D1;
- objects are stored in R2;
- upload/download access is checked against current project permissions;
- object keys remain immutable/versioned according to existing media rules;
- file size/type limits and malware/content policy are explicitly defined.

## 4. Quality requirements

### Accessibility

- Visible focus.
- Label/control/error association.
- Keyboard opening and activation.
- Escape behavior and focus return.
- Screen-reader names for icon-only controls.
- Menu arrow navigation where appropriate.
- Drag alternatives and announcements.
- Portalled content remains reachable and unclipped.

### Performance

- Record JavaScript and CSS bundle changes for new foundations.
- Poll only active/visible resources at the required frequency.
- Prefer incremental endpoints/cursors or conditional requests for large streams.
- Avoid re-fetching every project resource after a narrow mutation.

### Reliability

- Additive schema migrations.
- Idempotent delivery/event keys.
- Explicit migration and rollback procedures.
- Full repository verification before release.
- Production mutation only with human authorization.

### Brand

- Preserve Quincy fonts, colors, hairlines, radius and editorial hierarchy.
- Do not use raw Tailwind palette classes as the feature-level brand contract.
- Do not ship stock shadcn component appearance without Quincy customization.
- Compare migrated surfaces against matched prototype/current evidence at approved viewports and record intentional deviations.
- Preserve the design system's editorial hierarchy, square card geometry, restrained control radius, hairline structure, low elevation and calm motion unless a deviation is explicitly approved.

## 5. Non-goals

- Realtime chat, presence, typing indicators or Slack replacement.
- External managed comments/feed/Kanban vendors.
- React 19 or router migration as collateral work.
- Complete UI/CSS conversion before feature delivery.
- Dark mode unless separately approved.
- Replacing Tiptap or dnd-kit without a measured problem.
- Changing existing auth/capability or immutable-media rules incidentally.
- Changing the subtask due-date persistence contract.

## 6. Product decisions required before relevant slices

- Discussion/reply depth.
- Reaction set.
- Subscription levels.
- Notice-board replies and moderation.
- Pinning/priority/expiry/acknowledgement.
- Attachment scope.
- Polling delay expectations.
- Whether card detail is a route, sheet, dialog or responsive combination.
- Whether project system activity and human comments are visually interleaved.
- Whether priority is metadata-only, an explicit optional sort, or an ordering command; and the target-column insertion rule for a stage move.

## 7. Product-level acceptance

The revamp is successful when a staff member can:

1. Open Project A and Project B in separate tabs.
2. See another permitted user's project/board/comment change without pressing Reload.
3. Post/edit feedback without losing it during background refresh.
4. Follow a notification link directly to the correct project context.
5. Move a Kanban project accessibly and see the move persist/conflict safely.
6. Read notices and have their read state follow them across devices.
7. Receive deduplicated in-app/email events even when delivery retries occur.
8. Continue using the existing production workflows throughout incremental migration.
9. Recognize migrated surfaces as Quincy through approved typography, spacing, geometry, hierarchy and interaction behavior—not merely matching colors.
10. Switch Kanban sort modes and edit priority without invisible manual-order side effects or successful no-op reorder controls.
