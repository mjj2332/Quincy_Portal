# #959 / #973: admin routes vs the MCP route allowlist

Audit for ticket #973 (spec #959, ADR 0026). Scope: every Worker route whose permission check names a
capability only the Admin role holds (`packages/shared/src/capabilities.ts`): `adminBackend`,
`manageIntegrations`, `manageUsers`, `switchDeliveryPage`, `createProject`, `editProject`, `archiveProject`,
`prioritizeProjects`. `managePipelineConfig` and `manageDirectory` are held by Admins but no route checks
them by name (the Agency, contact and Stage routes check `adminBackend`).

Base: integration branch `feat/959-mcp-extension` at `f4ac055a` (#961, #962, #963, #971 merged). Paths are
`portal/workers/app/src/routes/` unless stated; every route is under `/api`.

## Outcome classes

- **Tool (existing):** already allowlisted and owned by a tool.
- **Tool added (#973):** the gap this ticket closes.
- **Never-list:** ADR 0026 keeps it out of MCP; `test/mcp-never-list.test.ts` fails the build if it is allowlisted.
- **Upload:** a file transfer; uploads are out of scope for the spec.
- **Other #959 ticket:** covered by a sibling ticket being built in parallel, so #973 adds no tool for it.
- **Not added:** with the reason.

## Gaps closed by #973

| Route | File | Capability | Tool | Scope |
|---|---|---|---|---|
| POST /admin/delivery-review-links/sync | admin.ts:446 | `adminBackend` | `admin_sync_delivery_review_links` | admin |
| POST /admin/video-versions/reprobe | admin.ts:472 | `adminBackend` | `admin_reprobe_video_versions` | admin |
| POST /projects/:projectId/cover | projects.ts:838 | `editProject` | `admin_set_project_cover` | admin |
| PUT /projects/:projectId/photographers/:userId | projects.ts:785 (`projectMembershipRoute`) | `editProject` | `admin_add_project_photographer` | admin |
| DELETE /projects/:projectId/photographers/:userId | projects.ts:785 | `editProject` | `admin_remove_project_photographer` | admin |
| GET /integrations | integrations.ts:52 | `manageIntegrations` | `admin_list_integrations` | read |
| GET /projects/:projectId/autohdr-status | projects.ts:988 | `adminBackend` | `admin_get_autohdr_status` | read |

- The reads are `read` scope, matching the existing admin reads (`tools/admin-reads.ts`): visibility comes from the
  capability. `GET /integrations` returns status, scopes, expiry and last error, never `encrypted_credentials`.
- `admin_get_autohdr_status` is the input `admin_resolve_autohdr_coverage` (#709) needs (handoff id, readiness units).
- The Photographer pair mirrors `add_project_editor` / `remove_project_editor`, including the route's own
  `subtask_assignment_confirmation_required` relayed as `Confirmation required`.
- Every write audits through `auditMeta(principal)`, so its rows carry `via: "mcp"`
  (`test/mcp-admin-more.test.ts`, `test/mcp-audit-parity.test.ts`).

## Scope divergence (owner decision, 2026-10-28)

ADR 0026 decision 2 puts writes on Admin-only capabilities in the `admin` scope. The tools #705 shipped on
`createProject`, `editProject`, `archiveProject` and `prioritizeProjects` are `write` scope and **stay that way by
owner decision**: `create_project`, `update_project_details`, `set_project_priority`, `set_project_deadline`,
`add_project_editor`, `remove_project_editor`, `archive_project`, `restore_project`. The #973 tools on `editProject`
(`admin_set_project_cover`, the Photographer pair) follow the ADR and the ticket ("all are `admin` scope"), so an
Admin needs the `admin` grant for Photographer assignment but not for Editor assignment. Aligning the two is an
owner call, not part of #973.

## Already reachable (tool exists)

| Route(s) | Capability | Tool(s) |
|---|---|---|
| GET /users | `manageUsers` | `admin_list_users` (read only; roles and active status cannot change) |
| GET /admin/attention; POST /admin/attention/orphan-uploads/:id/acknowledge | `adminBackend` | `admin_get_attention`, `admin_acknowledge_orphan_file_report` |
| GET /admin/notification-deliveries; POST …/:outboxId/replay, …/discard | `adminBackend` | `admin_list_notification_deliveries`, `admin_replay_notification_delivery`, `admin_discard_notification_delivery` |
| POST /admin/renditions/backfill, /admin/autohdr/backfill, /admin/autohdr/scaffold-backfill | `adminBackend` | `admin_backfill_renditions`, `admin_backfill_autohdr`, `admin_backfill_autohdr_scaffolds` |
| GET /admin/renditions-dlq; POST …/:id/replay, …/:id/discard | `adminBackend` | `admin_list_dead_letters`, `admin_replay_dead_letter`, `admin_discard_dead_letter` |
| GET/POST /admin/agencies, PATCH /admin/agencies/:id | `adminBackend` | `admin_list_agencies`, `admin_create_agency`, `admin_update_agency` |
| GET/POST /admin/agents, PATCH /admin/agents/:id | `adminBackend` | `admin_list_agency_contacts`, `admin_create_agent`, `admin_update_agent` |
| GET /admin/stages, PATCH /admin/stages/:key | `adminBackend` | `admin_list_stages`, `admin_update_stage` |
| GET /admin/webhook-events, GET …/:id, POST …/:id/retry, …/:id/discard | `adminBackend` | `admin_list_webhook_events`, `admin_get_webhook_event`, `admin_retry_webhook_event`, `admin_discard_webhook_event` |
| GET /admin/tonomo-health | `adminBackend` | `admin_tonomo_health` |
| POST /projects/:id/send-to-autohdr, /fetch-edited, /autohdr-coverage, /sync-dropbox | `adminBackend` | `admin_send_to_autohdr`, `admin_fetch_edited_from_autohdr`, `admin_resolve_autohdr_coverage`, `admin_sync_project_dropbox` |
| GET /projects/:id/jobs; POST /jobs/:id/retry | `adminBackend` | `admin_list_project_jobs`, `admin_retry_job` |
| DELETE /projects/:id | `adminBackend` | `delete_project` (confirm token) |
| DELETE /assets/:id | `adminBackend` | `admin_delete_asset` |
| GET /integrations/dropbox/editor-folders, …/monitors/:scope; POST …/editor-folders/inspect, …/link, …/monitors/:scope/reset, …/mappings/:mappingId/resolve, …/path-claims/reassign | `manageIntegrations` | `admin_preview_editor_folders`, `admin_inspect_dropbox_monitor`, `admin_inspect_editor_folder`, `admin_link_editor_folder`, `admin_reset_dropbox_monitor`, `admin_resolve_autohdr_mapping`, `admin_reassign_autohdr_path_claim` |
| POST /projects | `createProject` | `create_project` (write) |
| PATCH /projects/:id | `editProject` | `update_project_details` (write) |
| PUT /projects/:id/deadline | `editProject` | `set_project_deadline` (write) |
| PUT/DELETE /projects/:projectId/editors/:userId | `editProject` | `add_project_editor`, `remove_project_editor` (write) |
| POST /projects/:id/priority | `prioritizeProjects` | `set_project_priority` (write) |
| POST /projects/:id/archive, /restore | `archiveProject` | `archive_project`, `restore_project` (write) |
| GET /project-assignment-candidates | any of `createProject`, `editProject` | `list_project_assignment_candidates` |
| `archived` filters on GET /projects, /dashboard/people, /production-calendar, /production-gantt | `adminBackend` (per parameter) | parameters of `list_projects`, `list_people_for_filters`, `get_production_calendar`, `get_production_gantt` |

## Never-list

| Route(s) | Capability | Why |
|---|---|---|
| POST /users, PATCH /users/:id | `manageUsers` | role and active status, provisioning |
| GET/PATCH /users/mcp-settings, /users/impersonation-settings, /users/embedded-heic-settings, /users/external-provisioning-freeze | `manageUsers` | feature-flag settings, read and write |
| POST /admin/connected-apps/revoke-all (and DELETE /connected-apps/:id) | `manageUsers` (own session) | Connected-app revoke |
| POST /auth/admin/impersonate-user[/] | `manageUsers` | impersonation; `/api/auth` is never dispatchable |
| POST /integrations/dropbox/connect-url, GET /integrations/dropbox/callback | `manageIntegrations` | Dropbox OAuth handshake (credentials); in the never-list guard's DENYLIST (`dropbox-oauth`). Listed under "What MCP will not do" in the guide. |

## Upload

| Route(s) | Capability | Note |
|---|---|---|
| POST /admin/social-overlays (create), POST /admin/social-overlays/:id/image | `adminBackend` | multipart PNG; owner decision on #970 |
| POST /projects/:id/documents, /documents/presign, /documents/complete, /documents/:sessionId/abort; PUT /documents/direct/:sessionId/:slot | `editProject` or `manageExtras` | document upload sessions |
| GET /projects/:id/manual-upload-jobs | `adminBackend` | the upload dropzone's poll of its own publish jobs; the same jobs (and more) are in `admin_list_project_jobs` |

## Other #959 tickets (no #973 tool)

| Route(s) | Capability | Ticket |
|---|---|---|
| GET /admin/social-overlays, PATCH /admin/social-overlays/:id, POST …/:id/archive, …/:id/unarchive | `adminBackend` | #970 |
| PUT /projects/:projectId/delivery/page | `switchDeliveryPage` | #968 |

The non-admin new-feature routes (Video review writes, Review links, Release, Premium and Unlock, staff video
downloads) belong to #964–#967, #969 and #972 and hold no Admin-only capability, so they are outside this audit.

## Not added

| Route | Capability | Reason |
|---|---|---|
| GET /projects/:id/autohdr-history | `adminBackend` | No browser screen calls it (`apps/web` has no caller), so it is not an admin action the browser offers. Revisit if a screen uses it. `test/mcp-foundation.test.ts` uses it as its off-allowlist example. |
