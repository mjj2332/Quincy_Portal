---
status: accepted
---

# AI clients act as the staff member, through one remote MCP server on the app Worker

Staff want AI clients (Claude, ChatGPT, IDE assistants) to operate the Portal. Until now the only
way into the API has been a browser session cookie, with an `Origin === APP_ORIGIN` check on every
mutation. We add a remote MCP server at `/mcp` on the app Worker, with an OAuth 2.1 authorization
server in front of the existing Google sign-in. Each **Connected app** is delegated: it acts *as*
the staff member, with exactly their role's permissions. Every MCP tool calls the existing Hono
route in-process, so validation, author-only rules, audit, Project activity and notifications run
unchanged. A future reader will see a bearer-token path into `requireSession` that skips the
Origin check, and will wonder why. That path is this decision: on `/mcp`, the token check takes
the Origin check's place.

## Decision

1. **Delegated, not a separate principal.** The token resolves to the user. `requireSession`'s
   role, active and `authorizationEpoch` re-checks apply as they do for a cookie session, so
   deactivation or a role change cuts a Connected app off. Audit `meta_json` and Project activity
   carry `via: "mcp"` and the client name, and comments and activity show "via ‹client›".
2. **Tools call routes in-process.** Domain logic stays in the route handlers. Moving it into
   shared domain functions was declined for now: it is a large refactor of a live app.
3. **Scopes: `read`, `write`, `admin`.** `admin` covers admin writes. Its consent screen warns
   separately, and its access tokens last 15 minutes with no refresh. Access tokens under `read`
   and `write` last 1 hour; refresh tokens rotate and lapse after 30 days unused.
4. **Never through MCP:** changing any user's role or active status, feature flags, revoking
   Connected apps, and starting impersonation. These protect the controls that bound an AI
   client's own access, against prompt injection from Portal text the client reads. Uploads are
   also excluded, for size: multi-GB multipart transfers do not fit a tool call.
5. **Open dynamic client registration.** Any AI client may register; using one needs a staff
   Google sign-in and a consent screen that names the client, its redirect domain, and states
   "This app will see Portal data you can see". Consent is refused during an impersonation session.
6. **Kill switch.** The runtime flag `mcp_access` is off by default. Turning it on opens MCP to
   every role, external editors included.

## Considered options

- **Personal access tokens with a local stdio server.** Declined: hosted clients (claude.ai,
  ChatGPT) need remote OAuth, and Claude Code and Cursor can use remote OAuth too.
- **A separate bot principal per connection.** Declined: it would mean a second permission model.
- **An allowlist of known clients.** Declined: every new client would break until an Admin acts.

## Consequences

- Downloads need a new signed-URL mechanism: HMAC links scoped to one asset or one zip ticket,
  valid for 15 minutes, and audited.
- The whiteboard Durable Object must accept edits from a server-side participant, not only from
  WebSocket connections.
- The MCP route needs rate limiting per grant; the API has had none.

## Consequences as built

The decision stands as written. Where the build differs from the text above (operator detail:
`docs/Guides/MCP.md`):

- **Revocation has two layers.** Besides the `requireSession`-style role, active and
  `authorizationEpoch` re-checks, each Connected app is a live `mcp_connections` row in D1. That row is
  the revocation boundary; the OAuth library's grant is revoked best-effort alongside it. The OAuth
  library is Cloudflare `workers-oauth-provider`, with its state in `OAUTH_KV`.
- **`admin` scope is narrower than "admin reads and writes".** Admin reads are `read`-scope tools gated by
  the admin-only capability; the `admin` scope covers the destructive admin writes and `delete_project`.
- **Consent defaults.** Read is always on. Write is offered only when the client asked for it and starts
  ticked. Admin starts unticked and is offered to Admins only.
- **Rate limiting** is the Workers Rate Limiting binding (`MCP_CALLS`, `MCP_WRITES`), keyed by
  connection, not a Durable Object. A failing binding fails open and is logged.
- **Downloads** serve stored renditions only (`409 rendition_not_ready` otherwise), and redemption
  re-checks the live grant, so revoking an app kills links already issued.
- **Whiteboard.** Version restore is not exposed. A move is refused when it would re-route an elbow
  arrow with a pinned segment (`pinned_elbow_arrow`).
- **`delete_project`** needs the Project archived first, and its confirm token is an HMAC (5 minutes,
  per Project and connection) over a hash of the summary, so a changed Project is refused.
