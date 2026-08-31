# TB6 Slice 0 — TB4C producer inventory

This inventory was checked against `PROJECT_ACTIVITY_REGISTRY` on the TB6 Slice 0 base. The
registry has 22 entries with `cutover === "live"`; the four `project.workflow.*` entries remain
reserved and are listed separately below. `A` in the target-state columns means the Activity
resource introduced by TB6. The final column deliberately records the browser behavior that
exists on `main` today, not the coordinator behavior planned for TB6.

## Live registry entries

| Registry type | Server producer (registry `producerCallSites`) | Browser caller or background/system owner | Project resources (D6 target) | Dashboard effect (D6 target) | Calendar effect (D6 target) | Same-tab action (D6 target) | Cross-tab action (D6 target) | Background convergence (D6 target) | Browser mutation/invalidation call site on `main` today |
|---|---|---|---|---|---|---|---|---|---|
| `project.team.member_added` | `workers/app/src/lib/project-members.ts`; `workers/app/src/routes/projects.ts#createProjectAtomically` | `ProjectTeamControl.tsx`; `CreateProject.tsx` | existing: detail, collaboration-summary, A; create: no active project cache | assignment-scoped list/access; create adds a row | people/access/unscheduled facets | existing-project coordinator; create invalidates Board/Calendar | project resources + Board + Calendar + Activity; create sends Board + Calendar | affected detail/summary/Board/Calendar/Activity polling/focus/reconnect | `ProjectTeamControl.tsx#add` calls `beginProjectMembershipMutation(...).commit`; `project-data.ts#beginProjectMembershipMutation` settles by invalidating/publishing detail + collaboration-summary. `CreateProject.tsx#submit` posts and navigates; it has no browser invalidation/publish. No Activity, Board, or Calendar message is sent by either path. |
| `project.team.member_removed` | `workers/app/src/lib/project-members.ts#removeProjectMemberCycle` | `ProjectTeamControl.tsx` | detail, collaboration-summary, A; subtasks when assignments are cleared | assignment-scoped visibility | people/access and cleared checklist assignments | membership ledger, then coordinator including conditional subtasks | resources + Board + Calendar | affected detail/summary/subtasks/Board/Calendar/Activity refresh | `ProjectTeamControl.tsx#remove` calls `beginProjectMembershipMutation(...).commit(undefined, subtaskAssignmentsCleared)`. The membership ledger invalidates/publishes detail + collaboration-summary; the cleared count only adjusts the cached member count in `project-data.ts#mergeMembershipLedgerIntoCaches`—main does not invalidate subtasks, Board, Calendar, or Activity. |
| `project.deadline.schedule_changed` | `workers/app/src/lib/project-deadline.ts#saveProjectDeadlineSchedule` | `ProjectDeadlineControl.tsx`; `ProductionCalendar.tsx` | detail, A | card/list deadline metadata | event placement/reminders/overdue filters | coordinator after schedule settle | resources + Board + Calendar | detail, Board, Calendar, Activity polling/focus/reconnect | `ProjectDeadlineControl.tsx#save` and `#resume` call `invalidateProjectResources(...detail)` after success. `ProductionCalendar.tsx` deadline settle handlers invalidate detail + subtasks with `publish=false` and publish `production-calendar-invalidated`. No Activity or Board-specific invalidation. |
| `project.priority.changed` | `workers/app/src/routes/projects.ts#priority` | `Dashboard.tsx#setProjectPriority` | detail, A | card and priority sort | none | coordinator after optimistic Board commit | resources + Board | detail, Board, Activity refresh | `Dashboard.tsx#setProjectPriority` updates the local project list and calls `queueDashboardRefresh`, which refetches the active dashboard query. It does not invalidate detail or publish a project-data message. |
| `project.details.changed` | `workers/app/src/routes/projects.ts#patch` | `EditProject.tsx` | detail, A | address/shoot/card summary | title/search/project projection | coordinator after returned detail | resources + Board + Calendar | detail, Board, Calendar, Activity refresh | `EditProject.tsx#submit` writes the returned detail into the detail cache and calls `invalidateProjectResources(...detail)`. No explicit Board/Calendar/Activity invalidation. |
| `project.archived` | `workers/app/src/routes/projects.ts#archive` | `EditProject.tsx` | detail, A | active/archived scope move | remove from active Calendar | coordinator; close quick detail on role loss | resources + Board + Calendar | detail, Board, Calendar, Activity refresh; External remains fail-closed | `EditProject.tsx#archiveProject` posts `/archive`, invalidates detail, and navigates. No explicit Board/Calendar/Activity invalidation; the freshness boundary separately handles authorization loss. |
| `project.restored` | `workers/app/src/routes/projects.ts#restore` | `EditProject.tsx` | detail, A | restore to active scope | restore eligible Calendar data | coordinator | resources + Board + Calendar | detail, Board, Calendar, Activity refresh | `EditProject.tsx#restoreProject` posts `/restore`, invalidates detail, and navigates. No explicit Board/Calendar/Activity invalidation. |
| `project.checklist.item_created` | `workers/app/src/routes/project-subtasks.ts#post` | `SubtaskChecklist.tsx` | subtasks, A | no checklist projection | schedule/unscheduled/facets | coordinator after local row commit | resources + Calendar | subtasks, Calendar, Activity refresh | `SubtaskChecklist.tsx#add` updates local state and the subtasks cache, then calls `queryRuntime?.publish(createProjectDataInvalidationMessage(...subtasks))`; it does not locally invalidate/refetch and does not publish Calendar or Activity. |
| `project.checklist.item_updated` | `workers/app/src/routes/project-subtasks.ts#patch` | `SubtaskChecklist.tsx`; `ProductionCalendar.tsx` | subtasks, A | no checklist projection | title/done/assignee/schedule/filter state | coordinator through checklist/Calendar settle | resources + Calendar | subtasks, Calendar, Activity refresh | `SubtaskChecklist.tsx#update` uses `replace`, which updates local state/cache and publishes a subtasks message. Calendar schedule mutations use `ProductionCalendar.tsx` settle handlers to invalidate detail + subtasks and publish the Calendar message. |
| `project.checklist.item_deleted` | `workers/app/src/routes/project-subtasks.ts#delete` | `SubtaskChecklist.tsx` | subtasks, A | no checklist projection | remove event/unscheduled/facet counts | coordinator after local removal | resources + Calendar | subtasks, Calendar, Activity refresh | `SubtaskChecklist.tsx#remove` removes the local row/cache entry and publishes a subtasks message; no local invalidation, Calendar message, or Activity path exists. |
| `project.checklist.schedule_changed` | `workers/app/src/lib/project-subtasks.ts#saveProjectSubtask` | `SubtaskChecklist.tsx`; `ProductionCalendar.tsx` | subtasks, A | no checklist projection | range/due placement and filters | coordinator through schedule/Calendar settle | resources + Calendar | subtasks, Calendar, Activity refresh | Checklist schedule edits flow through `SubtaskChecklist.tsx#update`/`replace` and publish subtasks. Calendar schedule settle invalidates detail + subtasks and publishes Calendar. There is no Activity resource or coordinator. |
| `project.comment.created` | `workers/app/src/lib/project-comments.ts#createProjectComment` | current `ProjectCollaborationPanel.tsx` | comments, comment-read-marker, A | comments absent | comments absent | optimistic Discussion state; coordinator for marker + A | resources only | comments/read-marker/Activity bounded refresh | `ProjectCollaborationPanel.tsx#submit` prepends the returned comment, then calls `invalidateProjectCommentResources(...["comments", "comment-read-marker"])`, which invalidates and publishes those two existing resources. |
| `project.comment.edited` | `workers/app/src/lib/project-comments.ts#editProjectComment` | current `ProjectCollaborationPanel.tsx` | comments, A | comments absent | comments absent | draft/editor settle; coordinator for A | resources only | comments and Activity refresh | `ProjectCollaborationPanel.tsx#saveEdit` replaces the local comment and calls `invalidateProjectCommentResources(...["comments"])`, which invalidates and publishes comments only. |
| `project.comment.deleted` | `workers/app/src/lib/project-comments.ts#deleteProjectComment` | current `ProjectCollaborationPanel.tsx` | comments, comment-read-marker, A | comments absent | comments absent | local removal; coordinator for marker + A | resources only | comments/read-marker/Activity refresh | `ProjectCollaborationPanel.tsx#remove` removes the local comment and calls `invalidateProjectCommentResources(...["comments", "comment-read-marker"])`, which invalidates and publishes those two resources only. |
| `project.collection.video_link_added` | `workers/app/src/routes/collections.ts#post-link` | `CollectionPanel.tsx#addLink` | A only | links absent | links absent | Activity-only coordinator | Activity only | Activity refresh | `CollectionPanel.tsx#addLink` calls `reportLinksChanged()` after a 201 response; `ProjectWorkspace.tsx#onLinksChanged` calls `invalidateProjectResources(...detail)`, which invalidates and publishes detail. `loadLinks` is not called after the mutation. |
| `project.collection.video_link_changed` | `workers/app/src/routes/collections.ts#patch-link` | `CollectionPanel.tsx#saveEdit` | A only | links absent | links absent | Activity-only coordinator | Activity only | Activity refresh | `CollectionPanel.tsx#saveEdit` (line ~94) updates the component-local `links` state only — it does **not** call `reportLinksChanged()`, so there is no project-data invalidation or publish, and no detail/Activity path, on `main` today. |
| `project.collection.video_links_reordered` | `workers/app/src/routes/collections.ts#reorder-link` | `CollectionPanel.tsx#reorderLinks` | A only | link order absent | links absent | Activity-only coordinator | Activity only | Activity refresh | `CollectionPanel.tsx#reorderLinks` (line ~104) calls the component-local `loadLinks()` after the reorder — it does **not** call `reportLinksChanged()`, so there is no project-data invalidation or publish, and no detail/Activity path, on `main` today. |
| `project.collection.video_link_removed` | `workers/app/src/routes/collections.ts#delete-link` | `CollectionPanel.tsx#removeLink` | A only | links absent | links absent | Activity-only coordinator | Activity only | Activity refresh | `CollectionPanel.tsx#removeLink` calls `reportLinksChanged()` after DELETE; `ProjectWorkspace.tsx#onLinksChanged` invalidates/publishes detail, not Activity. |
| `project.collection.document_completed` | `workers/app/src/routes/collections.ts#complete-document` | `CollectionPanel.tsx#uploadCopy/#uploadFloorplan` | detail, assets(copy or floorplan), A | document versions absent | document versions absent | document callback + coordinator | resources only | detail/assets/Activity refresh | `CollectionPanel.tsx#uploadCopy` and `#uploadFloorplan` call `reportDocumentsChanged(kind)` after completion; `ProjectWorkspace.tsx#onDocumentsChanged` invalidates/publishes the matching assets resource + detail. No Activity. |
| `project.workflow.manual_edited_ready` | `workers/background/src/workflows/manual-edited-publish.ts` | background Workflow; Workspace job polling | detail, assets(edited), A | effective cover/card delivery can change | no Calendar field changes | no browser sender; Workspace job refresh | none from Worker | Workspace polling refreshes detail/edited assets; Board/Activity own refresh | `ProjectWorkspace.tsx#startCompanionBatch` loads jobs/ingest; active `#refreshUntilTerminal` polls `refreshJobs`, `forceAssetsRead("edited")`, and `forceDetailRead`. The background Worker sends no browser invalidation, and main has no Activity query. |
| `project.collection.raw_sync_completed` | `workers/background/src/dropbox/sync.ts#claim-completion` | background RAW reconciliation; `ProjectWorkspace.tsx#syncDropbox` observes status | detail, assets(raw), A | received count/cover/card summary | no Calendar field changes | no Worker message; Workspace sync/status refresh | none from Worker | sync/status refresh owns detail/raw assets; Board/Activity independently refresh | `ProjectWorkspace.tsx#syncDropbox` polls after the sync request, force-reads active/raw and edited assets, refreshes ingest/jobs, and publishes only changed asset resources. It does not publish Activity or a detail invalidation for this event. |
| `project.stage.changed` | `workers/app/src/lib/project-stage.ts#moveProjectStage` | `Dashboard.tsx`; `ProjectOverviewRail.tsx` → `ProjectWorkspace.tsx#moveStage` | detail, A | Stage identity/order | stage filters/delivered state | coordinator through Board/rail settle | resources + Board + Calendar | detail/Board/Calendar/Activity refresh | Dashboard `#runBoardMovement` publishes `dashboard-board-invalidated`, invalidates/publishes detail, and queues its Board refetch. Workspace `#moveStage` directly invalidates `dashboard-projects`, publishes Board + detail messages, then calls `onRefreshDetail()`. Neither path has Activity or Calendar invalidation. |

## Reserved workflow entries

These four entries are present in `PROJECT_ACTIVITY_REGISTRY` with `cutover === "reserved"` and
are intentionally excluded from the live inventory:

| Registry type | Owner/source contract |
|---|---|
| `project.workflow.raw_ready` | future canonical workflow owner; source kind `project_workflow` |
| `project.workflow.sent_to_editing` | future canonical workflow owner; source kind `project_workflow` |
| `project.workflow.edited_ready` | future canonical workflow owner; source kind `project_workflow` |
| `project.workflow.delivered` | future canonical workflow owner; source kind `project_workflow` |

## Cross-check against D6

The 22 live registry keys and every registry `producerCallSites` string match the D6 table. The
following are discrepancies between D6’s TB6 target-state table and `main` today, and are called
out rather than treated as shipped behavior:

- `A` is not a current browser resource. `ProjectDataResource`, `projectResourceKey`, and the
  browser query registry have no `activity` entry, so every D6 resource/action/convergence cell
  mentioning Activity is future state.
- D6’s coordinator action is not present on main. Membership, deadline, details, archive/restore,
  collection, and comments use direct resource helpers; checklist writes update local state and
  publish their existing subtasks message.
- D6’s create-project Board/Calendar invalidation is not present: `CreateProject.tsx#submit`
  posts and navigates without a browser invalidation.
- D6’s member-removal conditional subtasks invalidation is not present: main only folds the server
  count into the membership cache.
- D6’s link rows say Activity-only invalidation. On `main` today: `addLink` and `removeLink`
  call `reportLinksChanged()` → `ProjectWorkspace.tsx#onLinksChanged` invalidates/publishes project
  `detail`; `saveEdit` and `reorderLinks` do **not** call `reportLinksChanged()` (edit mutates
  local state; reorder calls the component-local `loadLinks()`), so they publish no project-data
  invalidation at all. TB6 adds the `activity` invalidation to all four; it does not remove the
  existing `addLink`/`removeLink` detail invalidation.
- D6’s checklist and discussion callers name the future extracted Discussion/coordinator seams;
  main still uses `SubtaskChecklist.tsx` and `ProjectCollaborationPanel.tsx` directly.
- D6’s stage row says coordinator resources + Board + Calendar; main has two direct stage paths
  (Dashboard movement and Workspace rail movement) with Board/detail messages and no Calendar or
  Activity message.
- D6’s background convergence includes Activity polling; main only has Workspace job/status and
  asset/detail refreshes for these background producers, with no Activity query to converge.

## Slice 2 External projection widen-list

When Activity joins the External surface, update these exact assertions/contracts:

- `portal/packages/shared/test/capabilities.test.ts`: the hardcoded
  `EXTERNAL_EDITOR_CAPABILITIES` array currently has 11 entries and its `toHaveLength(11)`
  assertion; add Activity and change the assertion to 12.
- `portal/workers/app/src/lib/terminal-route.ts`: widen the `externalSurface` union with
  `"activity"`.
- `portal/packages/shared/src/external-project-dto.ts`: widen `ExternalApiSurface` and add the
  Activity response schema to `EXTERNAL_API_RESPONSE_SCHEMAS`.
- `portal/workers/app/test/route-manifest.test.ts`: add the Activity external route probe and
  update the manifest/schema assertions for both the bare and trailing-slash route forms as
  required by the route contract.
- Grep result for `/me` fixtures: `portal/workers/app/test/api.test.ts:881` hardcodes the current
  11-entry external capability list and must be updated. `portal/workers/app/src/index.ts:67`
  derives its list from `ROLE_CAPABILITIES`; no second hardcoded `/me` list was found.
