# #699 spec: Portal MCP for AI clients (settled in grilling, 2026-10-08)

Parent spec for the Portal MCP work. Architecture decision: `docs/adr/0019`. Terms: **AI client**,
**Connected app** (`portal/packages/shared/GLOSSARY.md` § AI access). Status: settled with the
owner; implementation plan pending the parallel Opus + Codex review.

## Who and how

- Every staff role: admin, photographer, editor, external_editor. Clients have no login and are
  out of scope.
- A remote MCP server (Streamable HTTP) at `https://quincy.flamingfire.my/mcp` on the app Worker,
  with OAuth 2.1 and open dynamic client registration in front of the existing Google sign-in. The
  OAuth library is open for planning: better-auth `mcp`/`oidcProvider` plugin or Cloudflare
  `workers-oauth-provider`.
- Delegated identity: the AI client acts as the user, with that user's role permissions.
- Tools call existing Hono routes in-process. The bearer principal goes through the same
  `requireSession` re-checks (role, active, `authorizationEpoch`). On `/mcp` the token check
  replaces the Origin check.
- `tools/list` is filtered to what the user's role and granted scopes allow. The routes still
  enforce permissions on every call.
- Side effects match the UI exactly: notifications, emails, activity, audit.
- Audit `meta_json` and Project activity carry `via: "mcp"` plus the client name. Comments and
  activity show a subtle "via ‹client›" marker.

## Scopes and tokens

| Scope | Covers | Access token | Refresh |
|---|---|---|---|
| `read` | all reads below | 1 h | rotating, lapses after 30 d unused |
| `write` | non-admin writes | 1 h | rotating, lapses after 30 d unused |
| `admin` | admin-capability writes; separate warning on consent | 15 min | none |

The consent screen names the client and shows its redirect domain prominently. It also says "This
app will see Portal data you can see". Consent is refused during an impersonation session.

## Tools (v1)

Tool names use glossary terms. Every removal and every admin write is marked `destructiveHint`.

**Reads**
- Projects: search and list (address, Stage, Editor, dates), Project detail (Deadline, Editors,
  Subtasks, video links), my tasks, Stages, assignable people.
- Project collaboration: comments, activity.
- Assets: metadata (filename, Collection, rating, selected, review state). Download access is a
  signed URL (see below), never inline image content.
- Annotations, notice board, embedded media, link previews.
- Notifications.
- Whiteboard: the current board and its version list.
- Admin (admin role only): users, Tonomo health, webhook events, dead letters, jobs, Agencies and
  agents, and the other `/admin` reads.

**Writes**
- Project: create, details, priority, Deadline, Editors, Stage move, archive and restore.
  - When a Stage move returns `confirmation_required`, the tool returns the reason. The AI client
    must ask the user, then call again with `confirm: true`.
- Subtasks: create, edit, set due, set Subtask assignees, reorder, delete.
- Video links in the Video Collection: add, update, reorder, remove.
- Comments: add; edit and delete own (author-only).
- Annotations and notice board: same author-only rules as the UI.
- Review and selection: select assets for editing, set review state.
- Embedded media and link previews.
- Notifications: mark read.
- Whiteboard: add text, sticky notes, shapes and arrows; place existing Embedded media; edit text
  and position; delete elements.
  - Edits enter the Project's live Durable Object as a participant labelled "‹user› via ‹client›".
  - Version restore is excluded.
- Admin (`admin` scope): everything admin can do, **including Project delete** (server-enforced
  confirm round trip: the first call returns what will be destroyed and the AI client must call again
  with `confirm: true` after asking the user; `destructiveHint` alone is advisory), Dropbox and
  AutoHDR actions, dead-letter replay, and job retry, **except** the never-list below.
- Downloads: signed HMAC URLs, one per asset or per zip ticket, valid 15 minutes, audited
  `via: mcp`. Existing zip caps apply (500 assets / 256 MiB).

**Never through MCP**
- Changing any user's role or active status.
- Feature flags, including `mcp_access` and impersonation.
- Revoking Connected apps.
- Starting impersonation.
- Uploads (multi-GB multipart transfers).

## Control

- Runtime flag `mcp_access`, off by default (same pattern as `user_impersonation`). The first
  release opens it to all roles.
- A per-user **Connected apps** list in settings shows the client, scopes and last use, with a
  revoke button. Admins can revoke all. Deactivation, a role change or an epoch bump cuts off
  access.
- Rate limit per grant on `/mcp`: about 60 calls/min and 20 writes/min, with a
  clear error the AI client can read.

## Open for planning (not owner decisions)

- OAuth library choice and where its tables live (D1 migration).
- Internal dispatch mechanism: synthetic `Request` into the Hono app vs `app.request`, and how
  the bearer principal is injected.
- How `via` reaches the many raw `INSERT INTO audit_log` sites, not only `audit()`/`auditMeta()`.
- Server-side participant entry into `ProjectWhiteboardDO`, and the simplified element schema.
- Where the rate limiter's state lives (KV is eventually consistent; a Durable Object or the
  Workers rate-limit binding may fit better).
- Signed-URL design beside the existing `/__transform-source` HMAC.
- Ticket decomposition, the order of slices, and the reuse ledger for the Connected apps and
  consent UI.
