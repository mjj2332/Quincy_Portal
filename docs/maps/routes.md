Answers: where an API route is registered, which guard gates it, how to list every route, and how External responses are decoded.

## Registration (`portal/workers/app`)
- Root Hono app: `app` portal/workers/app/src/index.ts:45. Each `src/routes/*.ts` exports one Hono instance, e.g. `projectsRoutes` portal/workers/app/src/routes/projects.ts:446; paths inside carry no `/api` prefix.
- `/api`: sub-app `api` portal/workers/app/src/index.ts:74, `requireSession` on all of it portal/workers/app/src/index.ts:75, every route file chained with `.route("/", …)` portal/workers/app/src/index.ts:77, mounted by `app.route("/api", api)` portal/workers/app/src/index.ts:78.
- `/media`: own sub-app with `mediaNoStoreByDefault` + `requireSession` portal/workers/app/src/index.ts:81.
- Directly on `app`: `/api/health` portal/workers/app/src/index.ts:55, `/api/auth/admin/impersonate-user` portal/workers/app/src/index.ts:71, better-auth `/api/auth/*` portal/workers/app/src/index.ts:73, 404 terminal `/api/*` portal/workers/app/src/index.ts:80, SPA fallback `"*"` portal/workers/app/src/index.ts:115.

## Staff video review (#741)
- `portal/workers/app/src/routes/videos.ts` (`videosRoutes`, chained into `api` in `index.ts`): `GET /api/projects/:projectId/video-review` (External surface `video-review`) and `GET /api/projects/:projectId/videos` (every Video with its Versions embedded, newest first; External surface `video-list`). Playback is in `routes/media.ts`: `GET /media/video/:assetId` (range, If-Range, HEAD from `head()` alone; shares `serveR2Object` with embedded media; never a content-disposition) and `GET /media/video/:assetId/poster`. The gate is `lib/video-review-gate.ts` (feature-flag rows, `video_review*`); every route checks inline in the order 400 id, gate (closed 404), capability (403), Project visibility (External 404, staff 403), then on writes archived 409, and never uses `.use(...)`.
- **Notes (5a)** `routes/video-notes.ts` (`videoNotesRoutes`, SQL in `lib/video-notes.ts` and `lib/video-notes-sql.ts`; schemas in `packages/shared/src/video-notes.ts`): `GET` and `POST /api/projects/:projectId/video-versions/:assetId/notes` (list = External surface `video-note-list`), `POST .../video-notes/:noteId/replies`, `PATCH` and `DELETE .../video-notes/:noteId` (body `{ expectedRevision, ... }`), `PUT .../video-notes/:noteId/resolution` (`{ resolved }`). Gate part `notes` on every route; `viewVideo` to read, `annotateVideo` to write. Staff and an assigned External read AND write both visibilities (only the later guest surface filters internal, in SQL). Edit and delete are author-only in SQL with no role bypass (an impersonating Admin is the effective author); resolve/reopen is any staff, unrevisioned. A reply inherits visibility from its root inside the INSERT ... SELECT (`REPLY_INSERT_SQL`). Delete is a hard delete unless someone else replied, then a tombstone (`deleted: true`, empty body) that still resolves. Archived Project: reads 200, every write 409 `project_archived`, checked before the note lookup and repeated in the batch.
- Video-kind Assets are refused by every Asset-by-id door (`/media/asset`, `/projects/:id/assets`, `/assets/:id/review`, `DELETE /assets/:id`, `/__transform-source`, the two cover readers): they answer as an unknown id. The Video routes are the only way to a Version.

## Registrations a literal grep misses
| Registration | Routes |
|---|---|
| `for` loop portal/workers/app/src/routes/projects.ts:1193 | POST `/projects/:id/archive` and `/projects/:id/restore` |
| `uploadsRoutes[method]` portal/workers/app/src/routes/uploads.ts:193 | trailing-slash `/uploads/presign/`, `/uploads/direct/`, `/uploads/complete/` (403 External, else 404) |
| `projectMembershipRoute` portal/workers/app/src/routes/projects.ts:748, called at `projectMembershipRoute` portal/workers/app/src/routes/projects.ts:794 | PUT/DELETE `/projects/:projectId/{photographers,editors}/:userId` |

## The authoritative list
- `PROJECT_SECURITY_ROUTE_CLASSIFICATION_SEED` portal/workers/app/src/lib/terminal-route.ts:70 is the checked-in method+path list; `.use()` registrations are in `CHECKED_IN_MIDDLEWARE_REGISTRATIONS` portal/workers/app/src/lib/terminal-route.ts:284.
- `assertSecurityRouteManifest` portal/workers/app/src/lib/terminal-route.ts:341 checks registered vs. classified both ways; `assertSecurityRouteManifest(app.routes)` portal/workers/app/test/route-manifest.test.ts:97 runs it. **A new route needs a seed entry.**
- Print it (172 entries at this rev):

      grep -oE '\{ method: "[A-Z]+", path: "[^"]+"' portal/workers/app/src/lib/terminal-route.ts

- Run only the manifest test, from `portal/` (build the web app first; worker-app tests serve `apps/web/dist`):

      npm run build -w @quincy/web
      npx vitest run --config workers/app/vitest.config.ts test/route-manifest.test.ts

## Terminal routes
- `terminalRoute` portal/workers/app/src/lib/terminal-route.ts:9 stamps `TERMINAL_ROUTE_MARKER` portal/workers/app/src/lib/terminal-route.ts:7 on the final handler; write `xRoutes.get(p, terminalRoute(p, …))`. An unmarked handler fails the manifest test.
- `hasTerminalRouteMarker` portal/workers/app/src/lib/terminal-route.ts:22 unwraps composed handlers; `assertNoCustomOnError` portal/workers/app/src/lib/terminal-route.ts:313 rejects a custom `onError`.

## Guards
| Guard | Gates |
|---|---|
| `requireSession` portal/workers/app/src/middleware/session.ts:10 | 401 unless active user, valid role, matching `authorizationEpoch` portal/workers/app/src/middleware/session.ts:31; sets `c.set("user"` portal/workers/app/src/middleware/session.ts:41 |
| `requireCapability` portal/workers/app/src/middleware/capability.ts:8 | 403 by role capability; mounted with `.use`, e.g. `requireCapability("manageUsers")` portal/workers/app/src/routes/users.ts:26 |
| `hasProjectAccess` portal/workers/app/src/middleware/capability.ts:19 | called inline per route (e.g. `hasProjectAccess` portal/workers/app/src/routes/review.ts:70); resolves via `resolveVisibleProject` portal/workers/app/src/lib/visible-project-scope.ts:43 |
| `hasProjectCollaborationAccess` portal/workers/app/src/middleware/capability.ts:28 | narrower: admin, assigned member, or visible External |
| `hasProjectAccessForUser` portal/workers/app/src/middleware/capability.ts:50 | same as `hasProjectAccess` for a reloaded principal |
| `requireProjectAccess` portal/workers/app/src/middleware/capability.ts:14 | exported, no callers |
| `requireAppOrigin` portal/workers/app/src/middleware/origin.ts:10 | 403 on unsafe methods when `Origin` ≠ `APP_ORIGIN` portal/workers/app/src/middleware/origin.ts:12 |
| `requireImpersonationEnabled` portal/workers/app/src/lib/impersonation.ts:53 | runtime toggle on the impersonate route |

## MCP door and Connected apps (#702)
Mounted by `mountMcp` portal/workers/app/src/mcp/index.ts, called from `index.ts` before the SPA fallback and outside `/api` (no router-wide middleware; every route is a `terminalRoute`, class `bearer-protocol`).
- `ALL /.well-known/oauth-authorization-server[/*]`, `ALL /oauth/token`, `ALL /oauth/register` → `getAuthorizationServer(env).fetch` (portal/workers/app/src/mcp/oauth-server.ts); `ALL /.well-known/oauth-protected-resource[/*]` is built in `mountMcp`.
- `GET /oauth/authorize` → flag off 404; invalid request is a plain 400 page; else 302 to `/settings/connected-apps/consent/<handle>`.
- `ALL /mcp` and `ALL /mcp/` → flag off 404; `validateToken` + `loadMcpAuthority` (portal/workers/app/src/mcp/authority.ts) on every call; stateless Streamable HTTP; tools from `toolsFor` (portal/workers/app/src/mcp/tools/registry.ts).
- Read tools (#703): one registry entry per allowlisted GET (`mcp/tools/reads.ts`, `mcp/tools/admin-reads.ts`, built by `readTool` in `mcp/tools/define.ts`); `route-allowlist.ts` lists the templates and `test/mcp-reads.test.ts` checks tools and allowlist agree both ways. `toolsFor` hides a tool unless the scope is granted and the role holds the route's capability. Rate limit: `MCP_CALLS` 60/min and `MCP_WRITES` 20/min Workers Rate Limiting bindings keyed by connection id, applied per `tools/call` in `mcp/index.ts` (portal/workers/app/src/mcp/rate-limit.ts); absent bindings allow.
- `/api` (cookie session + Origin, never on the MCP allowlist; portal/workers/app/src/routes/connected-apps.ts): `GET|POST /api/connected-apps/consent/:handle`, `GET /api/connected-apps`, `DELETE /api/connected-apps/:id`, `POST /api/admin/connected-apps/revoke-all` (manageUsers, checked inline so no new middleware registration).
- Web: `/settings/connected-apps` and `/settings/connected-apps/consent/:handle` (`connected-apps`, `connected-app-consent` kinds in portal/packages/shared/src/staff-routes.ts).

## External-role DTOs (web)
- `externalApiGet` portal/apps/web/src/lib/external-api-response.ts:18 (not in dashboard-projects) → `decodeExternalResponse` portal/apps/web/src/lib/external-api-response.ts:14 → `EXTERNAL_API_RESPONSE_SCHEMAS[surface]` portal/apps/web/src/lib/external-api-response.ts:15.
- Caller example: `externalApiGet("project-list"` portal/apps/web/src/lib/dashboard-projects.ts:133.
- Schemas: `ExternalApiSurface` portal/packages/shared/src/external-project-dto.ts:252, `EXTERNAL_API_RESPONSE_SCHEMAS` portal/packages/shared/src/external-project-dto.ts:259; `externalAssetSchema` portal/packages/shared/src/external-asset-dto.ts:21 (leaf module, avoids an import cycle).
- The server parses with the same schemas (`externalAssetSchema` portal/workers/app/src/routes/review.ts:60); `drives every manifest-declared External projection` portal/workers/app/test/route-manifest.test.ts:136 checks each External route against its schema.

Last verified against 495766e9
