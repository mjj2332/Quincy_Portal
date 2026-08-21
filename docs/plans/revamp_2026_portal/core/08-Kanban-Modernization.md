# Kanban Ordering Correction and Interaction Modernization

**Status:** Proposed two-slice repair and modernization of the existing project board  
**Related:** [Kanban research](../research/Kanban-And-Trello-Research.md), [TB4B](../roadmap/TB4B-Project-Deadline-And-Reminders.md), [TB5A](../roadmap/TB5A-Kanban-Ordering-Model-Correction.md), [TB5B](../roadmap/TB5B-Kanban-Interaction-Modernization.md)

## 1. Important baseline

Quincy already has a Kanban board. It is not a future greenfield product.

Current model:

- card = project;
- column = pipeline stage;
- project holds `stageKey`, `priority`, `boardPosition`;
- board mode displays non-null-priority cards before null-priority cards, then `boardPosition`;
- shoot-date modes override priority grouping and manual order;
- priority mutation also repositions `boardPosition`;
- up/down mutation uses the flat persisted order, not the priority-grouped visible order;
- an accepted historical boundary case can persist a successful up/down change with no visible movement;
- stage movement appends to the target column's persisted order while retaining priority;
- card links to `/projects/:projectId`;
- native HTML5 drag events power the board today;
- dnd-kit is already used elsewhere in Quincy.
- cards currently display a RAW count and have no project deadline metadata.

The original prototype sorted its dashboard list by recent shoot date or suburb before filtering cards into columns. It had no priority/manual-position model. Production ordering is later product evolution, not an original-prototype invariant.

## 2. Product direction

Modernize the current project board rather than introducing a second generic task-board data model.

Do not treat the current ordering implementation as automatically correct merely because it is live. Correct its semantics first, then replace the interaction engine. A DnD refactor must not preserve or deepen visible/persisted-order contradictions.

The work is split deliberately:

1. **TB5A — ordering-model correction:** establish the canonical order, repair semantic mismatches and define migration/compatibility.
2. **TB5B — interaction modernization:** add dnd-kit, accessibility, automatic freshness and guarded conflicts against the approved TB5A contract.

TB4B precedes these slices and makes one bounded card metadata change: show the project due date/time when set and remove the card-level RAW count. It does not introduce deadline sorting or modify manual order. TB5A and TB5B must preserve this metadata contract while changing ordering and interaction behavior.

## 3. Comments are project comments

Because a Kanban card is a project:

```text
Kanban card discussion = project discussion
```

A card detail sheet/route may display project summary, stage/priority/assignment controls, activity, project discussion and links to the full workspace. Do not create a second comment table keyed to the same project card.

The compact card metadata shows a timezone-aware due label and overdue state with accessible text. Removing RAW count applies only to Kanban cards; project list/detail/collection counts remain available unless separately approved.

## 4. Ordering contract

TB5A must settle these product meanings before code changes:

- Is priority metadata-only, an explicit optional sort, or an ordering command?
- What is the sole authoritative manual-order field?
- What insertion rule applies when a project enters another stage?
- Which sort modes are view-only?
- When are manual reorder controls available?
- How are existing persisted values interpreted or migrated?

Recommended default:

- `boardPosition` is the sole persisted manual order within a stage.
- Priority is metadata. If priority ordering is useful, it is an explicit temporary **Priority** sort mode.
- Shoot-date ascending/descending modes are temporary view-only sorts.
- Changing priority or a temporary sort does not rewrite manual order.
- Manual reorder controls appear only in Board order.
- A stage move uses one documented insertion rule, initially append-to-target unless the move request explicitly carries a destination neighbor.
- One authoritative response determines the post-mutation state.

Required invariants regardless of the selected option:

- visible Board order equals persisted manual order;
- no display-only grouping can disagree with mutation neighbors;
- a successful reorder produces an immediate visible change;
- a metadata edit cannot secretly alter manual order unless the approved contract defines it as an ordering command;
- sort labels explain what is temporary and what is persisted;
- tie-breaking is deterministic;
- direct links/open-new-tab behavior is unaffected.
- deadline display is metadata-only and never changes `boardPosition`, priority or selected sort mode.

## 5. TB5A data and API work

TB5A should prefer reusing the existing project fields and data where possible. It may change endpoint semantics or add a guarded move contract, but it must not delete historical data before the corrected behavior is verified.

A guarded ordering request should identify the expected board snapshot/version and the intended destination, for example:

```json
{
  "targetStageKey": "edited_review",
  "beforeProjectId": "...",
  "afterProjectId": "...",
  "expectedVersion": 7
}
```

Server responsibilities:

- recheck capability and target stage;
- validate the selected sort/mutation is legal;
- compute and persist the canonical position;
- update only when the expected snapshot/version matches;
- return authoritative project/order state;
- audit once;
- return a conflict when another writer won.

The TB5A plan must determine whether current `priority`/`board_position` rows can be reinterpreted without migration, require a one-time normalization, or need an additive version/rank field. It must explicitly test production-shaped fixtures before choosing.

## 6. TB5B interaction engine

Recommended first implementation: dnd-kit, after TB5A is live or otherwise established as the approved contract.

Reasons:

- already installed and proven in Quincy;
- multiple sortable containers;
- pointer, touch and keyboard sensors;
- DragOverlay for scrollable/multi-container boards;
- Quincy-owned rendering and Tailwind/shadcn styling.

Compare Atlassian Pragmatic Drag and Drop only if the proof exposes a measured limitation in nested scroll/auto-scroll, large-board performance, drop indicators, touch, virtualization or collision behavior. Do not run two production board DnD engines simultaneously.

## 7. Accessibility

Every drag operation needs a non-drag equivalent:

- “Move to…” with stage choices;
- explicit within-column up/down or destination-position actions where supported;
- screen-reader source/destination announcements;
- visible drag handle;
- predictable focus after move/conflict;
- no whole-card draggable target that conflicts with the project link.

Pointer-only drag is not acceptable.

## 8. Sorting modes

Every mode must declare whether it is authoritative or view-only.

Recommended modes:

- **Board order:** authoritative persisted manual order; reorder controls enabled.
- **Shoot date ↑ / ↓:** view-only; reorder controls disabled.
- **Priority:** optional view-only mode only if the owner confirms it is useful.

Changing a view-only sort must not mutate any project. Editing metadata while a view-only sort is selected must not secretly change Board order.

## 9. Automatic freshness

Board queries include scope and sort where server-derived. The visible board refetches on the approved interval and on focus/reconnect.

After a move:

- update cache optimistically;
- apply the authoritative response;
- invalidate project list/detail queries narrowly;
- optionally broadcast same-browser invalidation;
- delay or reconcile background results during an active drag so refresh does not destroy the interaction.

## 10. Card detail and activity

TB6 decides whether quick detail is a sheet, dialog, route or responsive combination. The canonical project route remains `/projects/:projectId`.

Board operations may emit immutable structured activity events such as:

- `project.stage_changed`;
- `project.priority_changed`;
- `project.board_position_changed`.

Events and notifications follow the approved ordering semantics and are emitted exactly once.

## 11. Performance

Prototype and measure typical project count plus a 100+ card fixture, multiple columns, horizontal/nested scroll, cover images, keyboard/touch, and background refresh while idle—not during active drag. Do not add virtualization without measured need.

## 12. Tests

TB5A:

- current three-layer behavior captured as a regression fixture before change;
- selected canonical ordering semantics;
- no successful invisible reorder;
- priority edit has no hidden manual-order effect under the recommended model;
- temporary sort changes write nothing;
- stage-entry insertion policy;
- deterministic ties;
- legacy data normalization/reinterpretation;
- access and audit behavior.

TB5B:

- movement within/between columns and into empty columns;
- pointer/touch/keyboard/non-drag move;
- optimistic rollback and conflict response;
- route link/open new tab;
- external simulated change appears without reload;
- active drag survives/defer-reconciles refresh;
- activity/outbox written exactly once.
- due date/time renders at desktop and narrow board widths with an accessible overdue state;
- card-level RAW count is absent while other RAW-count surfaces are unchanged;
- TB5A/TB5B movement and refresh preserve the TB4B deadline metadata.

## 13. Non-goals

- Embedding Trello/Wekan/PLANKA.
- Creating a generic task-card schema before a non-project-card requirement exists.
- Duplicate card comments.
- Realtime multiplayer presence.
- Rewriting the historical implemented Kanban plans; they remain accurate records of what shipped.
