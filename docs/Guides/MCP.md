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
| `admin` | `delete_project` and the other admin-scope tools | 15 minutes | none |

A grant that includes `admin` gets the 15-minute token and **no refresh**: the client has to send you
through consent again. Scopes are explicit; `admin` does not imply `write`.

## What a client can see: tool visibility

`tools/list` is filtered twice: by the scopes the Connected app was granted, and by the capabilities the
staff member's role holds (the capability in the **Needs** column is the same one the route checks). The
routes still enforce permissions on every call, so a hidden tool is never the only protection.

With every scope granted, the tool count by role is:

| Role | Tools visible |
|---|---|
| Admin | 95 |
| Photographer | 37 |
| Editor | 46 |
| External editor | 38 |

Admin-only tools (every `admin_*` tool and `delete_project`) never appear for the other roles. An
External editor additionally has no notice board and no selection or download-selection tools.

## Tool reference

Generated from the tool definitions in `portal/workers/app/src/mcp/tools/` (registry plus the
whiteboard tools): **95 tools** in total. **Scope** is the OAuth scope a Connected app needs. **Needs** is
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
  again with `confirm: true` and the token. The token is good for 5 minutes, for that Project and that
  Connected app only. The server recomputes the summary on the second call and **refuses if the Project
  changed in between**; the client has to ask again.

## Signed downloads

`get_asset_download_url` and `get_selection_download_url` return `{ url, expiresAt }`. The link is a
bearer: whoever holds it can fetch the file until it expires, so do not paste it elsewhere.

- Valid for **15 minutes**, scoped to one asset or one zip ticket, and audited as a download via MCP.
- Redeeming it re-checks the live grant (flag on, Connected app not revoked, user active, epoch
  unchanged, `read` scope still held), so revoking an app kills links already handed out.
- **Stored renditions only.** If the requested rendition has not been generated yet, the link answers
  `409 rendition_not_ready` rather than building one. Try again later or request another variant.
- Zip selections keep the usual caps: 500 assets and 256 MiB.
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
- Change feature flags, including `mcp_access` and impersonation.
- Revoke Connected apps.
- Start impersonation.
- **Upload.** Multi-GB multipart transfers do not fit a tool call. `place_media` and the link-preview
  tools only reference things already in the Portal or a public URL.
- Restore a whiteboard version.

Only routes in the allowlist (`portal/workers/app/src/mcp/route-allowlist.ts`) can be dispatched.

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
  changed (epoch bump), or an admin-scope token (15 minutes) expired. Reconnect through consent.
- **A tool the client expects is missing.** Scope not granted, or the role lacks the capability. Compare
  with the table above.
- **`rate limit` errors.** Back off for about a minute.
- **`409 rendition_not_ready` on a download.** The rendition is not generated yet; see Signed downloads.
