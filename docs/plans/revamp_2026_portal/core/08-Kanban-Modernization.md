# Project Stage, Pipeline and Kanban Architecture

**Status:** Settled Stage/ordering and interaction proposal  
**Related:** [TB0B](../roadmap/TB0B-Pipeline-Configuration-Boundary.md), [TB4B](../roadmap/TB4B-Project-Deadline-And-Reminders.md), [TB4E](../roadmap/TB4E-External-Editor-Assigned-Scope-Access.md), [TB5A](../roadmap/TB5A-Project-Stage-And-Kanban-Ordering-Contract.md), [TB5B](../roadmap/TB5B-Kanban-Interaction-Modernization.md), [TB5C](../roadmap/TB5C-Production-Calendar.md)

## 1. Existing board

Quincy already has a project Kanban board: card = project, column = Stage, with `stageKey`, `priority`, and `boardPosition`. Current Board order groups non-null Priority ahead of null then uses `boardPosition`; shoot-date views override it; Priority mutation rewrites position; Up/Down can disagree with visible grouped order; Stage movement appends to target bottom; native HTML5 drag powers movement; dnd-kit is already installed; cards show RAW count and no project Deadline.

The revamp repairs semantics before replacing interaction.

## 2. Fixed system-stage semantics

Canonical progression:

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

Stable keys own machine behavior such as creation defaults, AutoHDR, Photographer visibility, automatic transitions, notifications, and non-admin presentation. Configurable display order/labels never redefine these semantics. Future custom/manual Stages require explicit transition semantics; Stage creation/deletion is outside this program.

## 3. Global pipeline boundary (TB0B)

`Admin → Pipeline` retains label editing and active/inactive management. Ordinary Admin self-service loses global Up/Down controls and the matching authenticated move endpoint. Existing `displayOrder` values remain; future global order changes are developer-managed through reviewed migration/script.

## 4. Project Stage command

Introduce one `moveProjectStage` capability and guarded command for rail and board.

Capability rollout:

- TB5A grants it to Admin and internal Editor.
- Because TB4E precedes TB5A in the revised sequence, TB5A also grants it to **External Editor within explicit assigned-project scope**.
- Capability never substitutes for `hasProjectAccess`; External Editor must still be a current project member.

Request concept:

```json
{
  "targetStageKey": "edited_review",
  "expectedStageKey": "editing_autohdr",
  "expectedBoardVersion": 7,
  "beforeProjectId": null,
  "afterProjectId": "..."
}
```

Rail/non-drag omit neighbours and append to target bottom; positional Kanban drag may supply exact neighbours; same-Stage rail choice is a no-op.

Server responsibilities:

- recheck project access and `moveProjectStage`;
- reject archived/inaccessible projects;
- validate active destination while allowing escape from current inactive Stage;
- apply semantic confirmation preconditions;
- compare expected Stage/revision;
- compute canonical target position;
- preserve Priority as metadata;
- update Stage/position atomically where possible;
- audit and create one structured activity/outbox intent;
- return authoritative project/order state;
- return `409` on stale premise; never auto-retry/last-write-wins.

## 5. Manual transition policy

- Normal one-step public forward: immediate.
- Backward: confirm.
- Forward skip: confirm.
- Enter/leave delivered: confirm.
- Enter/leave `editing_autohdr`: dedicated strong confirmation.
- Current inactive Stage remains visible/escapable; new destination must be active.
- Archived project remains read-only.

### `editing_autohdr`

Admins, internal Editors, and assigned External Editors may enter/exit it through `moveProjectStage`.

- Non-admin Editors, including External Editors, see neutral **Editing** copy; Admin may see configured internal label.
- Stage mutation never starts an AutoHDR handoff.
- Exiting never cancels/retires/deletes active work.
- Existing explicit send/retry/fetch/resolution actions retain their own capabilities.
- Automatic completion may update media/job state but cannot silently reassert Stage after expected Stage changed.

### `delivered`

Entering/leaving delivered changes Stage/position only. It never publishes/unpublishes/creates/revokes/deletes delivery artifacts. Entering emits the approved delivery/stage event once and supersedes pending project Deadline occurrences; leaving does not resurrect them.

## 6. Corrected ordering contract (TB5A)

- `boardPosition` is sole persisted manual order within a Stage.
- Priority is metadata; optional Priority view is temporary/non-writing: `1` highest through `10`, null last, tie by `boardPosition`, then ID.
- Shoot-date views remain temporary/non-writing.
- Priority/sort changes never rewrite manual order.
- Manual reorder controls only in Board order.
- Visible Board order equals persisted manual order.
- Successful reorder visibly moves or reports truthful no-op.
- Deadline is display metadata only.

Cutover normalizes each Stage once from current visible priority-grouped order into `boardPosition`, with deterministic tie-break and captured pre-normalization rollback state.

## 7. Authorization, notifications and activity

- Board/list queries must use the shared project-visibility predicate; External Editors receive assigned projects only, never a globally fetched corpus filtered in React.
- Stage changes notify eligible assigned Editors under TB4C/TB4E role-safe registry policy.
- Priority changes notify eligible assigned Editors where authorized.
- Pure position reorder creates no broad inbox row, though audit/activity may record it.
- One semantic movement has one producer/activity/source key.

## 8. TB5B interaction modernization

After TB5A baseline:

- replace native HTML5 drag with dnd-kit;
- dedicated drag handle separate from project link;
- pointer/touch/keyboard and non-drag **Move to…**;
- DragOverlay plus horizontal/nested scroll tests;
- optimistic cache update with authoritative response/rollback;
- reconcile/defer refresh during active drag;
- preserve direct/new-tab link behavior;
- test normal volume and 100+ cards;
- retain server-authorized External Editor assigned scope.

Never run two production Kanban drag engines. Compare another engine only after a measured blocker.

## 9. TB5C interaction handoff

Production Calendar uses FullCalendar rather than dnd-kit, but consumes the accepted interaction policy: source capability + server access, optimistic proposal, guarded mutation, stale rollback/no auto-retry, active-interaction refresh reconciliation, keyboard/non-drag equivalent, deterministic focus/announcement.

## 10. Project card metadata/detail

TB4B adds compact Deadline/overdue and removes only card RAW count. TB6 later uses URL-addressable Overview/Activity/Discussion and must apply role-safe External Editor projections.

## 11. Tests

TB5A/TB5B must include internal Admin/Editor and assigned/unassigned External Editor authorization, neutral Editing presentation, all semantic confirmation paths, normalization/manual-order identity, Priority/temp-sort non-writing behavior, conflicts, activity/outbox rules, Deadline/no-RAW preservation, pointer/touch/keyboard/non-drag behavior, refresh reconciliation and large-board performance.
