# Project Stage, Pipeline and Kanban Architecture

**Status:** Settled two-slice Stage/ordering and interaction proposal  
**Related:** [TB0B](../roadmap/TB0B-Pipeline-Configuration-Boundary.md), [TB4B](../roadmap/TB4B-Project-Deadline-And-Reminders.md), [TB5A](../roadmap/TB5A-Project-Stage-And-Kanban-Ordering-Contract.md), [TB5B](../roadmap/TB5B-Kanban-Interaction-Modernization.md)

## 1. Existing board

Quincy already has a project Kanban board:

- card = project;
- column = project Stage;
- fields = `stageKey`, `priority`, `boardPosition`;
- Board view currently groups all non-null Priority cards ahead of null and then uses `boardPosition`;
- shoot-date views override both;
- Priority mutation rewrites `boardPosition`;
- Up/Down uses flat persisted neighbours, which can disagree with visible grouping;
- Stage movement appends to target bottom;
- native HTML5 drag powers movement;
- dnd-kit is already installed elsewhere;
- cards show RAW count and no project Deadline.

This is not greenfield. The revamp must repair semantics before replacing interaction.

## 2. Fixed system-stage semantics

Canonical progression:

```text
awaiting_raw
→ raw_review
→ editing_autohdr
→ edited_review
→ delivered
```

These stable keys own machine behavior such as creation defaults, AutoHDR, photographer visibility, automatic transitions, notifications, and non-admin presentation. Configurable display order and labels never redefine those semantics.

Future custom/manual Stages require explicit transition semantics before participating. Stage creation/deletion is not in the current program.

## 3. Global pipeline boundary (TB0B)

`Admin → Pipeline` retains:

- label editing;
- active/inactive management.

Ordinary Admin self-service loses:

- Up/Down global Stage ordering UI;
- the corresponding authenticated self-service move endpoint.

Existing `displayOrder` values are preserved. Future global order changes are developer-managed through a reviewed migration/script. Hiding the UI alone is insufficient.

## 4. Project Stage command

Introduce one `moveProjectStage` capability and one guarded command for the rail and board. Grant it initially to Admins and Editors.

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

The neighbour fields are optional:

- rail picker and non-drag “Move to…” omit them and append to target bottom;
- positional Kanban drag supplies exact neighbours;
- same-Stage rail selection is a no-op.

Server responsibilities:

- recheck access and `moveProjectStage`;
- reject archived projects;
- validate active destination, while allowing escape from a current inactive Stage;
- apply semantic confirmation preconditions supplied by the client contract;
- compare expected Stage/revision;
- compute canonical target position;
- preserve Priority as metadata;
- update Stage/position atomically where possible;
- audit and create one structured activity/outbox intent;
- return authoritative project/order state;
- return `409` on stale premise; never silently retry or last-write-wins.

## 5. Manual transition policy

- Normal one-step forward move between public workflow Stages: immediate.
- Backward move: confirm.
- Forward skip over one or more semantic stages: confirm.
- Enter/leave `delivered`: confirm.
- Enter/leave `editing_autohdr`: dedicated strong confirmation.
- Inactive current Stage remains visible; active destinations only.
- Archived project remains read-only until restored.

### `editing_autohdr`

Admins and Editors may enter/exit it.

- Editors see neutral **Editing** copy; Admins may see configured internal label.
- Stage mutation never starts an AutoHDR handoff.
- Exiting never cancels, retires, or deletes active work.
- Existing send/retry/fetch/resolution actions retain their explicit permissions.
- Automatic completion may update media/job state but may not silently move the project back after expected Stage no longer matches.
- Confirmation states those consequences and active-handoff status; no typed street-name confirmation is required.

### `delivered`

Entering/leaving delivered changes Stage/position only. It never publishes, unpublishes, creates, revokes, or deletes client-delivery artifacts. Entering emits the approved delivery/stage event once. Entering delivered supersedes pending project Deadline occurrences; leaving does not resurrect them.

## 6. Corrected ordering contract (TB5A)

- `boardPosition` is the sole persisted manual order within a Stage.
- Priority is metadata.
- Optional Priority view is temporary and view-only: `1` highest through `10`, null last; ties use `boardPosition`, then ID.
- Shoot-date ascending/descending views are temporary and view-only.
- Priority and sort changes never rewrite manual order.
- Manual reorder controls exist only in Board order.
- Board visible order equals persisted manual order.
- A successful reorder always changes visible order or returns a no-op without claiming movement.
- Deadline is display metadata only.

### Cutover normalization

Before removing Priority grouping from authoritative Board order:

1. derive each Stage's current visible order using current priority grouping, existing `boardPosition`, and deterministic tie-breaker;
2. rewrite `boardPosition` once to encode that order;
3. capture pre-normalization state or a verified rollback record;
4. thereafter use the new contract only.

This avoids a rollout-day card reshuffle unrelated to user intent.

## 7. Notifications and activity

- Stage changes notify eligible assigned Editors.
- Priority changes notify eligible assigned Editors.
- Pure within-column position reorder does not create broad inbox rows.
- Position changes remain audited and may create structured activity for TB6.
- One semantic movement has one producer/activity/source key.

## 8. TB5B interaction modernization

After TB5A is live or established as the accepted implementation baseline:

- replace native HTML5 drag with dnd-kit;
- use dedicated drag handle separate from project link;
- support pointer, touch, keyboard, and non-drag “Move to…”;
- use DragOverlay and test horizontal/nested scroll;
- use optimistic cache update with authoritative response/rollback;
- reconcile or defer refresh during active drag;
- preserve direct/open-new-tab link behavior;
- test normal volume and 100+ cards.

Compare Pragmatic Drag and Drop only after a concrete measured blocker. Never run two production board engines.

## 9. Project card metadata/detail

TB4B:

- show compact Deadline/overdue metadata;
- remove card-level RAW count only;
- do not add Deadline sorting.

TB6:

- URL-addressable responsive sheet;
- separate Overview, Activity, Discussion;
- reuse project data/discussion/activity;
- canonical link to full workspace;
- no duplicate card/comment schema.

## 10. Tests

TB0B:

- Admin labels/active state still work;
- Up/Down UI absent;
- ordinary move endpoint absent/forbidden;
- existing display order unchanged.

TB5A:

- normalization preserves current visible order;
- Board visible/persisted order identity;
- Priority/sort write nothing to manual order;
- Priority numeric sort/null/ties;
- rail append and drag-neighbour insertion;
- inactive-stage escape;
- archived rejection;
- normal/backward/skip/delivered/AutoHDR confirmation contract;
- Editor neutral presentation;
- expected-state conflict;
- AutoHDR/delivery side effects remain separate;
- audit/activity/outbox exactly once;
- Deadline metadata and no card RAW count.

TB5B:

- within/between/empty-column moves;
- pointer/touch/keyboard/non-drag;
- drag/link separation;
- nested/horizontal scroll;
- conflict rollback and focus/announcement;
- active drag survives refresh;
- direct links/new tab;
- large-board performance;
- Deadline metadata retained.
