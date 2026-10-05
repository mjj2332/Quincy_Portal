Answers: where an API route is registered, which guard gates it, how to list every route, and how External responses are decoded.

## Registration (`portal/workers/app`)
- Root Hono app: `app` portal/workers/app/src/index.ts:45. Each `src/routes/*.ts` exports one Hono instance, e.g. `projectsRoutes` portal/workers/app/src/routes/projects.ts:446; paths inside carry no `/api` prefix.
- `/api`: sub-app `api` portal/workers/app/src/index.ts:74, `requireSession` on all of it portal/workers/app/src/index.ts:75, every route file chained with `.route("/", …)` portal/workers/app/src/index.ts:77, mounted by `app.route("/api", api)` portal/workers/app/src/index.ts:78.
- `/media`: own sub-app with `mediaNoStoreByDefault` + `requireSession` portal/workers/app/src/index.ts:81.
- Directly on `app`: `/api/health` portal/workers/app/src/index.ts:55, `/api/auth/admin/impersonate-user` portal/workers/app/src/index.ts:71, better-auth `/api/auth/*` portal/workers/app/src/index.ts:73, 404 terminal `/api/*` portal/workers/app/src/index.ts:80, SPA fallback `"*"` portal/workers/app/src/index.ts:115.

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

## External-role DTOs (web)
- `externalApiGet` portal/apps/web/src/lib/external-api-response.ts:18 (not in dashboard-projects) → `decodeExternalResponse` portal/apps/web/src/lib/external-api-response.ts:14 → `EXTERNAL_API_RESPONSE_SCHEMAS[surface]` portal/apps/web/src/lib/external-api-response.ts:15.
- Caller example: `externalApiGet("project-list"` portal/apps/web/src/lib/dashboard-projects.ts:133.
- Schemas: `ExternalApiSurface` portal/packages/shared/src/external-project-dto.ts:252, `EXTERNAL_API_RESPONSE_SCHEMAS` portal/packages/shared/src/external-project-dto.ts:259; `externalAssetSchema` portal/packages/shared/src/external-asset-dto.ts:21 (leaf module, avoids an import cycle).
- The server parses with the same schemas (`externalAssetSchema` portal/workers/app/src/routes/review.ts:60); `drives every manifest-declared External projection` portal/workers/app/test/route-manifest.test.ts:136 checks each External route against its schema.

Last verified against 495766e9
