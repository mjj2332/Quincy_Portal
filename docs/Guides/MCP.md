# Portal MCP (AI clients)

Staff can connect an **AI client** (Claude, ChatGPT, an IDE assistant) to the Portal. Each link is a
**Connected app**: one staff member's revocable grant letting one AI client act *as them*, with exactly
their role's permissions. No tool does anything the staff member could not do in the browser, and
the side effects (notifications, emails, activity, audit) are the same as the UI's. Decision record:
`docs/adr/0019-ai-clients-act-as-the-staff-member-through-remote-mcp.md`. Spec: `docs/plans/699-spec.md`.
Terms: `portal/packages/shared/GLOSSARY.md` § AI access.

The server is a remote MCP server (Streamable HTTP) on the app Worker:

```
https://quincy.flamingfire.my/mcp
```

It is **off by default**. An Admin turns it on with the `mcp_access` runtime flag (see
[Controls](#controls)). While the flag is off, `/mcp` answers 404 and every existing token stops working.

## Connecting a client (staff member)

1. Ask an Admin to confirm **Enable AI apps (MCP)** is on (Admin → Users).
2. In the AI client, add a custom connector or remote MCP server and paste the server URL above. Claude
   and ChatGPT call this a custom connector; IDE clients take it in their MCP settings.
3. The client registers itself (open dynamic client registration; there is no allowlist and no client id to
   copy), then sends you to the Portal.
4. Sign in with Google if you are not already signed in. That is the same sign-in as the Portal's.
5. The **consent screen** names the client and shows the domain it will return you to. A client running
   on your own computer (`localhost`) is flagged. It says the app will see Portal data you can see. Then
   choose what to grant:
   - **Read** is always on.
   - **Write** is a separate tick, offered only when the client asked for it, and it **starts ticked**.
     Untick it and the client can look but not change anything.
   - **Admin** is offered to Admins only, starts unticked, and carries its own warning. Only grant it to
     an app you trust.
6. Approve. The client is now listed under **Connected apps** (`/settings/connected-apps`).

Consent is **refused while you are impersonating** another user: connecting an app as someone else would
mint a grant under their name. Exit impersonation first.

Connecting again with the same client replaces the earlier grant for that client (the old one is revoked
as `superseded`).

## Scopes and token lifetimes

| Scope | Covers | Access token | Refresh token |
|---|---|---|---|
| `read` | every read tool, including the signed download links | 1 hour | rotating; lapses after 30 days unused |
| `write` | non-admin writes | 1 hour | rotating; lapses after 30 days unused |
| `admin` | `delete_project` and the other admin-scope tools | 15 minutes | rotating; refused 8 hours after consent |

A grant that includes `admin` gets the 15-minute token and a rotating refresh token, but only until
**8 hours after you consented** (ADR 0026): past that, refresh is refused and the client has to send you
through consent again. Refreshing never extends the 8 hours, and near the end the access token is cut
short to the time left. Revoking the app, a role change or deactivation, and the `mcp_access` flag
still cut it off at once, refresh included. Scopes are explicit; `admin` does not imply `write`.

## What a client can see: tool visibility

`tools/list` is filtered twice: by the scopes the Connected app was granted, and by the capabilities the
staff member's role holds (the capability in the **Needs** column is the same one the route checks). The
routes still enforce permissions on every call, so a hidden tool is never the only protection.

With every scope granted, the tool count by role is:

| Role | Tools visible |
|---|---|
| Admin | 142 |
| Photographer | 39 |
| Editor | 82 |
| External editor | 66 |

Admin-only tools (every `admin_*` tool and `delete_project`) never appear for the other roles. An
External editor additionally has no notice board and no selection or download-selection tools.

## Tool reference

Generated from the tool definitions in `portal/workers/app/src/mcp/tools/` (registry plus the
whiteboard tools): **142 tools** in total. **Scope** is the OAuth scope a Connected app needs. **Needs** is
the role capability. **Destructive** is the `destructiveHint` the client sees; every `admin`-scope tool is
destructive. `destructiveHint` is advice to the client, not enforcement: the server-side confirm round
trips below are what enforce.

Tool names use Portal terms. There is no tool for uploads.

### Reads (17)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `get_me` | read | any role | no |
| `list_projects` | read | any role | no |
| `my_tasks` | read | any role | no |
| `get_project` | read | any role | no |
| `list_stages` | read | any role | no |
| `list_project_assignment_candidates` | read | any of `createProject`, `editProject` | no |
| `list_subtask_assignee_options` | read | any role | no |
| `get_project_subtasks` | read | any role | no |
| `get_project_links` | read | `viewEdited` | no |
| `list_people_for_filters` | read | any role | no |
| `list_project_comments` | read | any role | no |
| `get_project_activity` | read | any role | no |
| `get_collaboration_summary` | read | any role | no |
| `list_project_assets` | read | any of `viewRaw`, `viewEdited` | no |
| `list_asset_annotations` | read | any of `viewRaw`, `viewEdited` | no |
| `list_notifications` | read | any role | no |
| `list_notice_board` | read | `viewNoticeBoard` | no |

### Core writes (22)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `create_project` | write | `createProject` | no |
| `update_project_details` | write | `editProject` | no |
| `set_project_priority` | write | `prioritizeProjects` | no |
| `set_project_deadline` | write | `editProject` | no |
| `add_project_editor` | write | `editProject` | no |
| `remove_project_editor` | write | `editProject` | yes |
| `move_project_stage` | write | `moveProjectStage` | no |
| `archive_project` | write | `archiveProject` | no |
| `restore_project` | write | `archiveProject` | no |
| `create_subtask` | write | any role | no |
| `update_subtask` | write | any role | no |
| `reorder_subtask` | write | any role | no |
| `delete_subtask` | write | any role | yes |
| `add_project_comment` | write | any role | no |
| `edit_project_comment` | write | any role | no |
| `delete_project_comment` | write | any role | yes |
| `add_video_link` | write | any of `editProject`, `manageExtras`, `uploadExtras` | no |
| `update_video_link` | write | any of `editProject`, `manageExtras`, `uploadExtras` | no |
| `reorder_video_link` | write | any of `editProject`, `manageExtras`, `uploadExtras` | no |
| `remove_video_link` | write | any of `editProject`, `manageExtras`, `uploadExtras` | yes |
| `mark_notification_read` | write | any role | no |
| `mark_all_notifications_read` | write | any role | no |

### Collaboration writes (11)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `create_annotation` | write | any of `annotateRaw`, `annotateEdited` | no |
| `edit_annotation` | write | any of `annotateRaw`, `annotateEdited` | no |
| `delete_annotation` | write | any of `annotateRaw`, `annotateEdited` | yes |
| `create_notice_post` | write | `viewNoticeBoard` | no |
| `edit_notice_post` | write | `viewNoticeBoard` | no |
| `delete_notice_post` | write | `viewNoticeBoard` | yes |
| `set_asset_review` | write | any of `selectForEditing`, `reviewEdited`, `recommendRaw` | no |
| `select_asset_for_editing` | write | `selectForEditing` | no |
| `unselect_asset_for_editing` | write | `selectForEditing` | yes |
| `request_project_link_preview` | write | `collaborateOnProject` | no |
| `request_notice_link_preview` | write | `viewNoticeBoard` | no |

#### Annotation markup (`strokes`) wire contract

`create_annotation` and `edit_annotation` take `strokes`: a list of up to 200 items, each one of two kinds. Every point is a fraction (0 to 1) of the image width and height, and `width` is in screen pixels (1 to 100). Colour is a non-empty string of at most 32 characters.

| Kind | Shape on the wire | Points |
|---|---|---|
| Freehand stroke | `{ "points": [...], "color": "#e64b3c", "width": 4 }` with **no `type` key** | 1 to 2000 (one point is a dot) |
| Arrow, line, rectangle | `{ "type": "arrow" \| "line" \| "rectangle", "points": [start, end], "color": "#e64b3c", "width": 4 }` | exactly 2: `[start, end]` as dragged |

- **A freehand stroke is typeless.** There is no `"freehand"` value; `type: "freehand"` is refused. Strokes saved before shapes existed are byte for byte this kind.
- An **arrow** points from the first point to the second; the head is drawn at the second. A **rectangle** takes two opposite corners in either order. A shape whose two points are equal is accepted and draws as at most a dot.
- The MCP tool is strict: an extra key on an item or a point is refused. The cookie route used by the web app is loose (an unknown key is stripped), but an unknown `type` is a 400 on both.
- The same caps apply to both kinds: at most 200 items and 2,000,000 bytes of JSON per annotation.
- `GET /media/annotation/:id` (the `markupUrl` on an annotation) returns this JSON as stored, so a reader should expect both kinds in one list. A reader that meets a `type` it does not know should skip that item and keep the data.

### Downloads (2)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `get_asset_download_url` | read | any of `viewRaw`, `viewEdited` | no |
| `get_selection_download_url` | read | any of `selectForEditing`, `downloadFinal` | no |

### Whiteboard (3)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `get_project_whiteboard` | read | `collaborateOnProject` | no |
| `list_whiteboard_versions` | read | `collaborateOnProject` | no |
| `edit_project_whiteboard` | write | `collaborateOnProject` | yes |

### Admin (40)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `admin_list_users` | read | `manageUsers` | no |
| `admin_tonomo_health` | read | `adminBackend` | no |
| `admin_list_webhook_events` | read | `adminBackend` | no |
| `admin_get_webhook_event` | read | `adminBackend` | no |
| `admin_list_dead_letters` | read | `adminBackend` | no |
| `admin_list_notification_deliveries` | read | `adminBackend` | no |
| `admin_list_agencies` | read | `adminBackend` | no |
| `admin_list_agency_contacts` | read | `adminBackend` | no |
| `admin_list_stages` | read | `adminBackend` | no |
| `admin_get_attention` | read | `adminBackend` | no |
| `admin_list_project_jobs` | read | `adminBackend` | no |
| `admin_preview_editor_folders` | read | `manageIntegrations` | no |
| `admin_inspect_dropbox_monitor` | read | `manageIntegrations` | no |
| `admin_reset_dropbox_monitor` | admin | `manageIntegrations` | yes |
| `admin_link_editor_folder` | admin | `manageIntegrations` | yes |
| `admin_resolve_autohdr_mapping` | admin | `manageIntegrations` | yes |
| `admin_reassign_autohdr_path_claim` | admin | `manageIntegrations` | yes |
| `admin_send_to_autohdr` | admin | `adminBackend` | yes |
| `admin_fetch_edited_from_autohdr` | admin | `adminBackend` | yes |
| `admin_retry_job` | admin | `adminBackend` | yes |
| `admin_replay_dead_letter` | admin | `adminBackend` | yes |
| `admin_retry_webhook_event` | admin | `adminBackend` | yes |
| `admin_create_agency` | admin | `adminBackend` | yes |
| `admin_update_agency` | admin | `adminBackend` | yes |
| `admin_create_agent` | admin | `adminBackend` | yes |
| `admin_update_agent` | admin | `adminBackend` | yes |
| `admin_update_stage` | admin | `adminBackend` | yes |
| `admin_backfill_renditions` | admin | `adminBackend` | yes |
| `admin_backfill_autohdr` | admin | `adminBackend` | yes |
| `admin_backfill_autohdr_scaffolds` | admin | `adminBackend` | yes |
| `admin_sync_project_dropbox` | admin | `adminBackend` | yes |
| `admin_resolve_autohdr_coverage` | admin | `adminBackend` | yes |
| `admin_replay_notification_delivery` | admin | `adminBackend` | yes |
| `admin_discard_notification_delivery` | admin | `adminBackend` | yes |
| `admin_discard_dead_letter` | admin | `adminBackend` | yes |
| `admin_discard_webhook_event` | admin | `adminBackend` | yes |
| `admin_acknowledge_orphan_file_report` | admin | `adminBackend` | yes |
| `admin_delete_asset` | admin | `adminBackend` | yes |
| `admin_inspect_editor_folder` | admin | `manageIntegrations` | no |
| `delete_project` | admin | `adminBackend` | yes |

### Video review reads (4)

Added in #963. Admins, Editors and External editors (on assigned Projects only) see these; a
Photographer sees none. They answer 404 while video review is off for the Project, as the routes do.

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `list_project_videos` | read | `viewVideo` | no |
| `list_video_version_summaries` | read | `viewVideo` | no |
| `list_video_notes` | read | `viewVideo` | no |
| `get_video_note_drawing` | read | `viewVideo` | no |

- **Timing.** Each Version carries its `fps` (`{ num, den }`) and `frameCount`; `list_video_version_summaries`
  adds both to each summary. `list_video_notes` returns the Version's timing as `version` and labels every
  note's `startFrame`, `endFrame` (exclusive) and `drawingFrame` with an SMPTE timecode on that Version
  (`startTimecode`, `endTimecode`, `drawingTimecode`).
- **Who wrote it.** Every note and reply carries `authorKind`: `"staff"` or `"guest"`.
- **Guest text is untrusted.** A Guest reviewer's name, note body and rich content are never plain fields.
  They are only in `untrustedGuestText`: one string, `<untrusted-guest-text>{json}</untrusted-guest-text>`,
  whose JSON writes `<`, `>` and `&` as `<`, `>` and `&`, so a guest cannot close the
  delimiter from inside it. A staff copy of a guest note (pasted onto a new Version) stays
  `authorKind: "staff"`, but its body and the guest's name (`copiedFromAuthorName`) are untrusted too. The
  server's MCP `instructions` tell the client this text is outside data, never instructions.
- `get_video_note_drawing` returns the drawing in the annotation `strokes` wire contract above.

### Planning and notification preferences (4) (#971)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `get_production_calendar` | read | `viewProductionCalendar` | no |
| `get_production_gantt` | read | `viewProductionCalendar` | no |
| `get_notification_preferences` | read | any role | no |
| `update_notification_preferences` | write | any role | no |

The Calendar and the Gantt are the same routes the Calendar and Gantt screens use, so they return the same data and
the same refusals. Photographers do not hold `viewProductionCalendar` and are not offered them; an External editor
sees only the Projects assigned to them. `get_production_calendar` takes a `start` (inclusive) and `end` (exclusive)
of at most 42 days, plus optional filters. `get_production_gantt` pages Projects with `cursor` and a Project's
Subtasks with `childrenOf`. The `archived` filter is admin only.

The two notification preference tools read and change the signed-in staff member's own preferences (Deadline and
Subtask reminder emails, digest cadence, whether the digest includes Project activity). They take no user id, so
they cannot reach anyone else's row. A change is audited as `notification.preference.update` with the usual
`via: "mcp"` marker.

### Video and Version management (9) (#965)

Admins and Editors see all nine; an External editor (on assigned Projects) sees the two Version writes; a
Photographer sees none. They answer 404 while video review is off for the Project (the Trash tools also need the
`trash` part), as the routes do.

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `set_version_review_status` | write | `annotateVideo` | no |
| `rename_video_version` | write | `uploadVideo` | no |
| `list_video_trash` | read | `manageVideoTrash` | no |
| `get_version_removal_impact` | read | `manageVideoTrash` | no |
| `get_video_removal_impact` | read | `manageVideoTrash` | no |
| `remove_video_version` | write | `manageVideoTrash` | yes |
| `delete_video` | write | `manageVideoTrash` | yes |
| `restore_video_version` | write | `manageVideoTrash` | no |
| `restore_video` | write | `manageVideoTrash` | no |

- **Review status** is `in_review` or `approved_internal`. Setting `approved_internal` is the internal approval
  decision and needs `approveVideoInternal` (Admin and Editor); an External editor can set `in_review` only, and the
  route answers 403 otherwise. `expectedStatus` is the status the client read: a changed one is 409
  `review_status_conflict`, and a Version that is no longer the latest is 409 `not_latest_version`. The Client
  approval decisions and Release belong to the release tools, not here.
- **Rename** changes a Version's file name (`.mp4` or `.mov`; `.mov` is stored as `.mp4`).
- **Delete and remove do not confirm.** They move the Video or Version to the Video Trash, and Restore brings it back
  (for the retention period shown by `list_video_trash`), so they carry `destructiveHint` instead. Read the impact
  first (`get_version_removal_impact`, `get_video_removal_impact`) and pass it as `expected`; if the Video or Version
  changed since, the route answers 409 `impact_changed` with the fresh impact and nothing is removed. Removing the last
  Version needs `removeVideo: true` (409 `last_version` otherwise); a Video published in Client Delivery or with an
  upload in progress is refused. Restoring a Version whose Video is in Trash is 409 `video_in_trash`: restore the Video
  first.
- Every write is audited as through MCP (`via: "mcp"`).

### Video note writes (5) (#964)

Admins, Editors and External editors (on assigned Projects only) see these with the `write` scope; a
Photographer sees none. They answer 404 while video notes are off for the Project (and while markup is off,
for a call that carries a drawing), as the routes do.

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `create_video_note` | write | `annotateVideo` | no |
| `reply_to_video_note` | write | `annotateVideo` | no |
| `edit_video_note` | write | `annotateVideo` | no |
| `delete_video_note` | write | `annotateVideo` | yes |
| `set_video_note_resolution` | write | `annotateVideo` | no |

- **Frames or a timecode.** Each moment (`start`, `end`, `drawing`) is given as a frame (`startFrame`,
  `endFrame` exclusive, `drawingFrame`) or as a timecode (`startTimecode`, `endTimecode`, `drawingTimecode`),
  never both. A timecode is SMPTE on that Version (`HH:MM:SS:FF`, `;` for drop-frame, start timecode
  included, as `list_video_notes` labels notes) or elapsed time from the start (`0:42`, `1:02:03.5`). The tool
  reads the Version's timing, resolves the timecode to the nearest frame and sends frames; frames are sent
  unchanged. The result is the thread plus `resolved`: per moment given, the `frame` used, its SMPTE
  `timecode`, and `fromTimecode` when it came from one. `edit_video_note` needs `assetId` (the note's Version)
  with a timecode.
- **Visibility is required** on create, with no default, and cannot change afterwards: `public` is seen by
  Guest reviewers on a Review link, `internal` by staff only. A reply takes its note's visibility.
- **Drawings** use the annotation `strokes` wire contract above with the video limits (hex colour, width 1 to
  24), and `drawingFrame` must be the note's frame or inside its range. `markup: null` on edit removes one; a
  note with a drawing cannot be moved.
- **Route errors pass through unchanged**: `frame_out_of_range` (with the Version's `frameCount`),
  `drawing_frame_outside`, `note_conflict` (a stale `expectedRevision`; its thread is shaped like every other,
  guest text untrusted), `markup_locks_frames`, `project_archived`.
- **Author-only.** Editing or deleting someone else's note or reply is refused (HTTP 403), for Admins too.
  Resolving and reopening are not author-only. Every write is audited (`video_note.*`) with the `via: "mcp"`
  marker and notifies staff exactly as the browser does.

### Social overlays (6) (#970)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `admin_list_social_overlays` | read | `adminBackend` | no |
| `admin_update_social_overlay` | admin | `adminBackend` | yes |
| `admin_archive_social_overlay` | admin | `adminBackend` | yes |
| `admin_unarchive_social_overlay` | admin | `adminBackend` | yes |
| `get_project_social_overlays` | read | `viewVideo` | no |
| `set_project_social_overlays` | write | `chooseSocialOverlays` | no |

The Admin tools manage the agency's overlay library: list it, rename an overlay or change its platform label,
archive it and bring it back. They need the `admin` scope and are hidden from every other role. Each change names
the overlay `revision` from the list; a stale one answers `overlay_conflict`. Archiving the Default overlay is
refused by the route (`default_overlay`). The Project tools are the Project's overlay picker: `get_project_social_overlays`
returns what the Project can offer, what it does offer and a `revision`; `set_project_social_overlays` replaces the
selection and needs that revision (`social_overlays_conflict` returns the current state). They answer 404 while Video
review is off for the Project, and an archived Project is read-only. Changes are audited as `social_overlay.*` and
`project.social_overlays.*` with the usual `via: "mcp"` marker. Creating an overlay and replacing its image are
uploads, so there is no tool for them.

### Video downloads (2) (#972)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `get_video_version_download_url` | read | `downloadVideo` | no |
| `get_marker_export_download_url` | read | `viewVideo` | no |

Admins, Editors and External editors (on assigned Projects only) see these; a Photographer sees neither. Both return
`{ url, expiresAt }`, a signed link under the rules in "Signed downloads" below.

- `get_video_version_download_url` takes a `projectId` and a Version's `assetId` (from `list_project_videos`). The link
  serves the Version's original file with the same name and headers as the browser's Download. Any live Version
  downloads, superseded or unreleased included. It answers 404 while the video review `download` part is off.
- `get_marker_export_download_url` takes the same ids, a `format` (`edl` for a DaVinci Resolve marker EDL, `fcpxml`),
  and optionally `includeInternal` (default false) and `status` (`all`, `open` or `resolved`; default `all`). The
  link serves the same file the browser's Marker export does. A note outside the Version's frames, or an EDL over 999
  markers, is refused when the link is requested (`HTTP 422`). It answers 404 while the `notes` or `export` part is off.
- Requesting a link downloads nothing: the tool checks access with a `HEAD` of the route, which writes no audit row.
  Each **redemption** is the download: audited as `video_version.download` (or `video_note.export`) with
  `via: "mcp"`, plus `mcp_download.redeem`.
- The link always serves the whole file: a `Range` header is not passed on, so a resumed fetch starts again and is
  audited again.

### Review links (10) (#966)

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `list_review_links` | read | `shareVideo` | no |
| `create_review_link` | write | `shareVideo` | no |
| `update_review_link` | write | `shareVideo` | no |
| `add_review_link_video` | write | `shareVideo` | no |
| `remove_review_link_video` | write | `shareVideo` | yes |
| `set_review_link_grants` | write | `shareVideo` | no |
| `revoke_review_link` | write | `shareVideo` | yes (confirm first) |
| `replace_review_link` | write | `shareVideo` | yes (confirm first) |
| `delete_review_link` | write | `shareVideo` | yes (confirm first) |
| `end_review_link_guest_sessions` | write | `shareVideo` | yes (confirm first) |

The same routes as the Review links panel, so the same refusals: 404 while Review links are off for the Project,
409 `project_archived` on an archived Project (Revoke, Delete and End guest sessions are still allowed there, as in
the browser). Admins, Editors and External editors see them; an External editor reaches links only on the Projects
they are assigned to (#834), and anything else is the route's 404. A Photographer sees none.

- `list_review_links` returns every link, the Delivery review link (`delivery: true`) first, with its Videos and the
  Versions each grants, expiry, status (`active`, `expired`, `revoked`), what guests may do (`allow`), guest activity
  and `url`, the address (null once revoked). **Passcodes are never returned**: a link only says `hasPasscode`.
- `create_review_link` takes the Videos, an optional label, expiry (one hour to 365 days; 30 days by default),
  passcode, `allow`, and per-Video `grants` (each Video otherwise grants its current Version). It returns
  `{ link, url }`; `url` is what the client sends to the customer.
- `update_review_link`, `add_review_link_video`, `remove_review_link_video` and `set_review_link_grants` change a live
  link. A revoked link and the Delivery review link refuse them (`link_revoked`, `delivery_review_managed`).
- **Revoke, Replace, Delete and End guest sessions** ask first: see [Confirm round trips](#confirm-round-trips).
  Revoke stops the address for good and ends the link's guest sessions; Replace issues a new `url` and ends the old
  one's sessions (refused on an expired link); Delete removes a revoked link from the list (an unrevoked one is
  refused with `link_not_revoked`).
- **The Delivery review link** is managed by the Delivery page. Revoke and Delete on it are refused with
  `delivery_review_managed`, as in the browser. End guest sessions is the one change allowed there, and the only
  link it works on: on an ordinary link it answers 404 (use Replace or Revoke to sign its guests out).
- Every change is audited (`review_link.*`) with the usual `via: "mcp"` marker. No audit row carries the passcode or
  the address.

### Remaining admin tools (7) (#973)

The admin routes the #973 audit (`docs/plans/959-admin-mcp-audit.md`) found with no tool. Admin only. The writes
need the `admin` scope and are destructive; the reads are `read` scope like the other admin reads.

| Tool | Scope | Needs | Destructive |
|---|---|---|---|
| `admin_sync_delivery_review_links` | admin | `adminBackend` | yes |
| `admin_reprobe_video_versions` | admin | `adminBackend` | yes |
| `admin_set_project_cover` | admin | `editProject` | yes |
| `admin_add_project_photographer` | admin | `editProject` | yes |
| `admin_remove_project_photographer` | admin | `editProject` | yes |
| `admin_list_integrations` | read | `manageIntegrations` | no |
| `admin_get_autohdr_status` | read | `adminBackend` | no |

- **Delivery review-link sync** and **video reprobe** are the operator backfills, one page per call with a
  `nextCursor`. Run `dryRun: true` first: the sync's dry run counts what it would create, and the reprobe's
  `dryRun` defaults to `true` (as on the route) and writes nothing, audit included. Each real run writes one summary
  audit row (`admin.delivery_review_backfill`, `admin.video_probe_backfill`) marked via MCP.
- **Photographer assignment** mirrors `add_project_editor` / `remove_project_editor` on the Photographer route:
  removing someone who holds Subtasks returns `Confirmation required` first (the route's own check); call again
  with `confirm: true` and `confirmedAssignmentCount`.
- **`admin_set_project_cover` and the Photographer tools** are `admin` scope, as ADR 0026 decision 2 asks of an
  Admin-only capability (`editProject`). The older tools on Admin-only capabilities (`create_project`, `update_project_details`, `set_project_priority`,
  `set_project_deadline`, the Editor tools, `archive_project`, `restore_project`) stay `write` by owner decision;
  that divergence is recorded in the audit.
- `admin_list_integrations` never returns credentials. Connecting Dropbox stays in the browser.

## Confirm round trips

Some actions need the person's say-so first. The tool refuses to act on the first call and the client
must ask the user, then call again.

- **Stage moves.** A backward move, a skipped Stage, or a move into or out of Delivered or Editing
  returns `Confirmation required` with the reason and changes nothing. The client relays the reason to
  the user, then calls `move_project_stage` again with `confirm: true`. A stale `expectedStageKey` or
  `expectedBoardRevision` is refused. `remove_project_editor` works the same way when it would clear
  Subtasks or cut an External editor's access.
- **`delete_project`** (admin scope, and the Project must be archived first). The first call deletes
  nothing: it returns a summary of what would be destroyed (photos by Collection and state, comments,
  Subtasks) and a `confirmToken`. The client shows the user that summary, and only on agreement calls
  again with `confirm: true` and the token. The token is good for 5 minutes, for that action, that
  Project and that Connected app only: a token issued for one action (delete, Publish, Unlock) is refused
  by every other. The server recomputes the summary on the second call and **refuses if the Project
  changed in between**; the client has to ask again.
- **Review links (#966).** `revoke_review_link`, `replace_review_link`, `delete_review_link` and
  `end_review_link_guest_sessions` act at once in the routes, so the tool itself asks first: without
  `confirm: true` it returns `Confirmation required` with what the action does (guests lose the address or
  are signed out) and sends nothing to the Portal. The client relays that to the user and, on agreement,
  calls again with `confirm: true`. There is no token: each call names the link, and the route refuses
  what it would refuse in the browser (the Delivery review link, an unrevoked link to delete).

## Signed downloads

`get_asset_download_url` and `get_selection_download_url` return `{ url, expiresAt }`. The link is a
bearer: whoever holds it can fetch the file until it expires, so do not paste it elsewhere.

- Valid for **15 minutes**, scoped to one asset, one zip ticket, one Video Version, or one Marker export
  of a Version (its format and options are part of the link; #972), and audited as a download via MCP.
- Redeeming it re-checks the live grant (flag on, Connected app not revoked, user active, epoch
  unchanged, `read` scope still held), so revoking an app kills links already handed out.
- **Stored renditions only.** If the requested rendition has not been generated yet, the link answers
  `409 rendition_not_ready` rather than building one. Try again later or request another variant.
- Zip selections keep the usual caps: 500 assets, and 256 MiB until `native_zip` is on (#802).
- **`get_selection_download_url` outcomes (#802).** Success is `{ url, expiresAt }`. When the zip's checksums are still being
  prepared the tool returns a normal, non-error result `{ status: "preparing", code: "download_preparing", pending, retryAfterSeconds,
  message }` ("preparing; try again in about a minute"): wait and call it again, no link is issued and nothing is audited. A selection
  over the size limit is an error (`download_too_large`, from the 413), and a file that is missing or changed is an error
  (`download_unavailable`, from the 502).
- A bad, tampered or revoked link is a bare `403`; an expired one is `410`.

## Whiteboard

`edit_project_whiteboard` enters the Project's live whiteboard as a participant labelled
"‹user› via ‹client›", so everyone with the board open sees the change at once. The client sends a short
list of simple commands (text, sticky notes (colours yellow, green, blue, pink or purple: the Portal's own note papers, no hex), shapes, arrows, existing Embedded media, edit, delete) and
the server builds the real elements. Edits apply in order and all-or-nothing, against the `generation` the
client just read: if the board was restored since, the call is refused and the client reads it again.

Limits:

- **No restore.** Restoring a version replaces everyone's board, so it stays a person's action in the
  Portal. `list_whiteboard_versions` is read-only.
- **A move is refused for shapes that have a pinned elbow arrow** (`pinned_elbow_arrow`, nothing
  applied). The server cannot route those the way the editor does, so move that shape in the board
  editor. Other arrows follow the shape.
- No uploads: `place_media` only places Embedded media already on that Project's board.
- An Archived Project refuses edits.

## Rate limits

Per Connected app: **60 calls per minute** and **20 writes per minute**. Any `tools/call` counts as a
call; a call to a tool without `readOnlyHint` also counts as a write. Over the limit, the client gets a
tool error saying which limit and to retry in about 60 seconds. If the limiter itself errors, calls are
let through and the error is logged (`mcp_rate_limiter_failed`).

## Provenance: the "via ‹client›" marker

Everything done through MCP is attributed to the staff member and marked as made through the client:

- Audit `meta_json` and Project activity carry `via: "mcp"` and the client name.
- Comments and activity entries made through a Connected app show a subtle **via ‹client›** marker
  after the author's identity pills.
- Downloads are audited the same way.

The author is always the staff member, so author-only rules (annotations, comments, notice board) apply
to them exactly as in the UI.

## What MCP will not do

These are never exposed, so an AI client cannot loosen the controls that bound its own access (a Portal
comment a client reads could try to talk it into it):

- Change any user's role or active status.
- Read or change feature flags, including `mcp_access` and impersonation.
- Revoke Connected apps.
- Start impersonation.
- **Upload.** Multi-GB multipart transfers do not fit a tool call. `place_media` and the link-preview
  tools only reference things already in the Portal or a public URL.
- Restore a whiteboard version.
- Connect Dropbox: its OAuth handshake runs in the browser (#973 audit).
- Set a Version's poster (#965). The poster route takes a raw JPEG body, which is an upload.
- Create a Social overlay or replace its image (a multipart PNG upload, #970).

Only routes in the allowlist (`portal/workers/app/src/mcp/route-allowlist.ts`) can be dispatched.
`test/mcp-never-list.test.ts` fails the build if a route from this list is ever added to it.

## Controls

- **`mcp_access` flag.** Admin → Users → **Enable AI apps (MCP)**. Runtime D1 flag, no deploy needed, off
  by default, flipped by an audited admin PATCH. Off means `/mcp`, the OAuth endpoints and `/dl/*`
  all refuse.
- **Connected apps page.** Every staff member sees their own at `/settings/connected-apps`: client,
  redirect domain, scopes, last used, and a **Revoke** button per app.
- **Revoke all.** Admin → Users → **Revoke all Connected apps** revokes every live grant, for everyone.
  Audited (`connected_app.revoke_all`).
- **Epoch revocation.** A user's `authorizationEpoch` is stamped on the grant at consent. Deactivating the
  user, or changing their role, bumps it; every later call (and download redemption) sees the mismatch
  and the Connected app is cut off with no per-app action. The `mcp_connections` row in D1 is the
  revocation boundary; the OAuth library's copy is revoked best-effort alongside it.

## Operations

Bindings and secrets on the app Worker (`portal/workers/app/wrangler.jsonc`). Names only; never write the
values anywhere:

- `OAUTH_KV`: KV namespace for the OAuth provider's state and the consent handles.
- `MCP_CALLS` and `MCP_WRITES`: Workers Rate Limiting bindings (60 and 20 per 60 seconds, keyed by
  connection). Their `namespace_id`s are account-wide, so keep them unique.
- `MCP_DOWNLOAD_SECRET`: Worker secret keying the download signatures and the `delete_project` confirm
  token (different domain-separation prefixes, so one can never verify as the other).

The `mcp_connections` table and the `mcp_access` flag row (seeded off) arrive by D1 migration; read
`docs/Guides/CI-Deploy.md` before merging one.

**Turn it on.** Confirm the bindings and secret exist in the deployed Worker, then Admin → Users → switch
**Enable AI apps (MCP)** on. Then connect one client yourself with Read only and call `get_me`; while the flag is off `/mcp` answers 404.

**Turn it off.** Switch the same toggle off. This takes effect on the next request; existing tokens
are not revoked, just unusable until the flag is back on.

**Roll back.** In order: (1) flag off, which stops everything at once; (2) **Revoke all Connected apps**,
so that nothing comes back to life if the flag is re-enabled; (3) only then consider a code revert, via
`docs/Guides/CI-Deploy.md`. Signed download links already issued die with the flag or the revoke, since
redemption re-checks the grant.

## If something looks wrong

- **Client says "unauthorized" / reconnect loop.** The flag is off, the app was revoked, the user's role
  changed (epoch bump), or an admin-scope grant passed its 8 hours from consent. Reconnect through consent.
- **A tool the client expects is missing.** Scope not granted, or the role lacks the capability. Compare
  with the table above.
- **`rate limit` errors.** Back off for about a minute.
- **`409 rendition_not_ready` on a download.** The rendition is not generated yet; see Signed downloads.
