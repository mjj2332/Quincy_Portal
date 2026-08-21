# Kanban Modernization Architecture

**Status:** Proposed modernization of the existing project board  
**Related:** [Kanban research](../research/Kanban-And-Trello-Research.md), [TB5](../roadmap/TB5-Kanban-Modernization.md)

## 1. Important baseline

Quincy already has a Kanban board. It is not a future greenfield product.

Current model:

- card = project;
- column = pipeline stage;
- project holds `stageKey`, `priority`, `boardPosition`;
- date sort can override board order;
- card links to `/projects/:projectId`;
- stage movement is optimistically applied and persisted;
- native HTML5 drag events power the board today;
- dnd-kit is already used elsewhere in Quincy.

## 2. Product direction

Modernize the current board rather than introducing a second generic task-board data model.

The board should continue to represent production projects unless a separate product requirement explicitly adds non-project cards.

## 3. Comments are project comments

Because a Kanban card is a project:

```text
Kanban card discussion = project discussion
```

A card detail sheet/route may display:

- project summary;
- stage/priority/due/assignment controls;
- project activity;
- project discussion;
- links to full workspace.

Do not create a second comment table keyed to the same project card.

## 4. Interaction engine

Recommended first implementation: dnd-kit.

Reasons:

- already installed and proven in Quincy;
- supports multiple sortable containers;
- supports pointer, touch and keyboard sensors;
- supports DragOverlay for scrollable/multi-container boards;
- allows Quincy-owned rendering and Tailwind/shadcn styling.

Compare Atlassian Pragmatic Drag and Drop only if the proof exposes a measured limitation in:

- nested scroll/auto-scroll;
- large-board performance;
- drop indicators;
- touch behavior;
- virtualization;
- collision behavior.

Do not add two production board DnD engines simultaneously.

## 5. Accessibility

Every drag operation must have a non-drag equivalent.

Required controls:

- “Move to…” menu with stage choices;
- keyboard sortable behavior or explicit up/down/column actions;
- screen-reader announcement of source/destination;
- visible drag handle;
- avoid making the whole link/card an ambiguous draggable trigger;
- focus remains predictable after move/conflict.

Pointer-only drag is not acceptable.

## 6. Data and conflicts

Continue using project fields unless the plan deliberately changes them:

```text
stage_key
priority
board_position
updated_at and/or version
```

Recommended move request includes an expected version or equivalent guarded snapshot:

```json
{
  "targetStageKey": "edited_review",
  "beforeProjectId": "...",
  "afterProjectId": "...",
  "expectedVersion": 7
}
```

Server behavior:

- recheck move capability;
- validate active target stage;
- calculate/persist board position;
- update only if expected snapshot/version still matches;
- return authoritative project/position;
- emit activity event and notification intent where applicable;
- return conflict when another writer won.

Client behavior:

- optimistic move;
- rollback or refetch on failure;
- on conflict, show a clear notice and load current board state;
- avoid silent overwrite.

## 7. Sorting modes

Preserve distinction:

- board mode: priority + `boardPosition`/manual ordering;
- shoot-date modes: date sorting overrides manual ordering.

When date sorting is active:

- drag/manual board-position actions should be disabled or clearly explained;
- changing priority may persist but not visually reorder until board mode.

## 8. Automatic freshness

Board query key includes scope/sort where server-derived. Visible board should refetch on the approved interval and on focus/reconnect.

After a move:

- update cache optimistically;
- apply authoritative response;
- invalidate project list/detail queries narrowly;
- optional BroadcastChannel invalidation updates another same-browser tab quickly.

Background refresh must not interrupt an active drag. Delay or reconcile incoming board data until drag end.

## 9. Card detail

TB6 should decide presentation:

- deep-linkable route `/projects/:projectId` remains canonical;
- optional responsive sheet/dialog can provide quick detail;
- sheet state should be reflected in the URL only if deep linking/Back behavior is required;
- full project workspace remains available.

The detail experience reuses project discussion and activity; it does not create a separate card domain.

## 10. Activity

Board operations can emit immutable structured events:

```text
project.stage_changed
project.priority_changed
project.board_position_changed
```

These may appear in the project/card timeline and drive notifications according to preferences.

## 11. Performance

Prototype and measure:

- typical project count;
- stress fixture with 100+ cards;
- multiple columns;
- nested/horizontal scroll;
- cover images;
- keyboard and touch;
- background refetch during idle, not drag.

Do not introduce virtualization unless board volume demonstrates need.

## 12. Tests

- movement within/between columns;
- empty column drop;
- pointer/touch/keyboard/non-drag move;
- optimistic rollback;
- conflict response;
- date-sorted mode behavior;
- priority/position persistence;
- route link/open new tab;
- board refetch after external simulated change;
- active drag not destroyed by refresh;
- access failure;
- activity/outbox written exactly once.

## 13. Non-goals

- Embedding Trello/Wekan/PLANKA.
- Creating a generic task-board schema before a non-project-card requirement exists.
- Replacing project discussion with card-specific duplicate comments.
- Realtime multiplayer board presence.
