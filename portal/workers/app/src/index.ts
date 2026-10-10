import { Hono } from "hono";
import { terminalRoute } from "./lib/terminal-route";
import { cors } from "hono/cors";
import { externalMeResponseSchema, ROLE_CAPABILITIES, VIDEO_KEY_PATTERN } from "@quincy/shared";
import type { AppEnv, Env } from "./env";
import { fetchWithServerTiming } from "./lib/server-timing";
import { bootTimingRoutes } from "./routes/boot-timing";
import { getAuth } from "./auth";
import { requireSession } from "./middleware/session";
import { mediaNoStoreByDefault } from "./middleware/media-cache-default";
import { requireCapability } from "./middleware/capability";
import { requireImpersonationEnabled } from "./lib/impersonation";
import { usersRoutes } from "./routes/users";
import { projectsRoutes } from "./routes/projects";
import { uploadsRoutes } from "./routes/uploads";
import { integrationsRoutes } from "./routes/integrations";
import { reviewRoutes } from "./routes/review";
import { mediaRoutes } from "./routes/media";
import { annotationsRoutes } from "./routes/annotations";
import { adminRoutes } from "./routes/admin";
import { stagesRoutes } from "./routes/stages";
import { collectionsRoutes } from "./routes/collections";
import { noticeBoardRoutes } from "./routes/notice-board";
import { notificationsRoutes } from "./routes/notifications";
import { assetsRoutes } from "./routes/assets";
import { mentionableUsersRoutes } from "./routes/mentionable-users";
import { projectCommentsRoutes } from "./routes/project-comments";
import { embeddedMediaRoutes } from "./routes/embedded-media";
import { videosRoutes } from "./routes/videos";
import { videoUploadsRoutes } from "./routes/video-uploads";
import { videoNotesRoutes } from "./routes/video-notes";
import { reviewLinksRoutes } from "./routes/review-links";
import { videoApprovalRoutes } from "./routes/video-approval";
import { videoTrashRoutes } from "./routes/video-trash";
import { videoMarkerExportRoutes } from "./routes/video-marker-export";
import { linkPreviewRoutes } from "./routes/link-previews";
import { projectSubtasksRoutes } from "./routes/project-subtasks";
import { projectDeadlineRoutes } from "./routes/project-deadline";
import { notificationPreferencesRoutes } from "./routes/notification-preferences";
import { externalUploadsRoutes } from "./routes/external-uploads";
import { projectAccessSnapshotRoutes } from "./routes/project-access-snapshot";
import { dashboardPeopleRoutes } from "./routes/dashboard-people";
import { productionCalendarRoutes } from "./routes/production-calendar";
import { productionGanttRoutes } from "./routes/production-gantt";
import { projectActivityRoutes } from "./routes/project-activity";
import { projectWhiteboardRoutes } from "./routes/project-whiteboard";
import { connectedAppsRoutes } from "./routes/connected-apps";
import { mountMcp } from "./mcp";
import { mountMcpDownloads } from "./mcp/downloads";
import { guestNotFound, mountGuest } from "./guest";
import { verifyTransformSource } from "./lib/transform-source";
import { requireAppOrigin } from "./middleware/origin";
import { safeStaffDestination } from "@quincy/shared";
import { boardSchemaVariant } from "@quincy/db";

export const app = new Hono<AppEnv>();
app.use("/api/*", async (c, next) => cors({ origin: c.env.APP_ORIGIN, credentials: true, allowHeaders: ["content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] })(c, next));
// This is the app isolate's one schema-version read. It runs before any API/auth handler can
// touch D1; board-aware routes reuse the memoized result rather than probing independently.
app.use("/api", async (c, next) => { await boardSchemaVariant(c.env.DB); await next(); });
app.use("/api/*", async (c, next) => { await boardSchemaVariant(c.env.DB); await next(); });
// Scope this middleware to /api explicitly: router-wide '*' middleware mounted at
// '/' can leak into sibling routes (see docs/lessons.md).
app.use("/api", requireAppOrigin);
app.use("/api/*", requireAppOrigin);
app.get("/api/health", terminalRoute("/api/health", (c) => c.json({ ok: true, env: c.env.APP_ENV })));
app.all("/api/auth/sign-in/social", terminalRoute("/api/auth/sign-in/social", async (c) => {
  if (c.req.method !== "POST") return getAuth(c.env).handler(c.req.raw);
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await c.req.raw.clone().json<unknown>();
    body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { /* Better Auth will produce its normal malformed-body response. */ }
  // Better Auth owns OAuth state/PKCE. This wrapper only constrains every caller
  // controlled redirect field to the same canonical relative staff-path grammar.
  const callbackFields = ["callbackURL", "newUserCallbackURL", "errorCallbackURL"];
  if (!body || callbackFields.some((field) => !(field in body) ? field === "callbackURL" : safeStaffDestination(body[field]) === null)) {
    return c.json({ error: "Invalid sign-in callback destination" }, 400);
  }
  return getAuth(c.env).handler(c.req.raw);
}));
app.post("/api/auth/admin/impersonate-user", requireSession, requireCapability("manageUsers"), requireImpersonationEnabled, terminalRoute("/api/auth/admin/impersonate-user", (c) => getAuth(c.env).handler(c.req.raw)));
app.post("/api/auth/admin/impersonate-user/", requireSession, requireCapability("manageUsers"), requireImpersonationEnabled, terminalRoute("/api/auth/admin/impersonate-user/", (c) => getAuth(c.env).handler(c.req.raw)));
app.all("/api/auth/*", terminalRoute("/api/auth/*", (c) => getAuth(c.env).handler(c.req.raw)));
const api = new Hono<AppEnv>();
api.use("/*", requireSession);
api.get("/me", terminalRoute("/me", (c) => { const { via: _via, ...user } = c.get("user"); const response = { user, capabilities: [...(ROLE_CAPABILITIES[user.role] ?? [])] }; return c.json(user.role === "external_editor" ? externalMeResponseSchema.parse(response) : response); }));
api.route("/", usersRoutes).route("/", projectsRoutes).route("/", projectDeadlineRoutes).route("/", notificationPreferencesRoutes).route("/", externalUploadsRoutes).route("/", uploadsRoutes).route("/", collectionsRoutes).route("/", integrationsRoutes).route("/", reviewRoutes).route("/", annotationsRoutes).route("/", stagesRoutes).route("/", adminRoutes).route("/", noticeBoardRoutes).route("/", mentionableUsersRoutes).route("/", projectCommentsRoutes).route("/", embeddedMediaRoutes).route("/", videosRoutes).route("/", videoUploadsRoutes).route("/", videoNotesRoutes).route("/", reviewLinksRoutes).route("/", videoApprovalRoutes).route("/", videoTrashRoutes).route("/", videoMarkerExportRoutes).route("/", linkPreviewRoutes).route("/", projectSubtasksRoutes).route("/", notificationsRoutes).route("/", assetsRoutes).route("/", projectAccessSnapshotRoutes).route("/", dashboardPeopleRoutes).route("/", productionCalendarRoutes).route("/", productionGanttRoutes).route("/", projectActivityRoutes).route("/", projectWhiteboardRoutes).route("/", connectedAppsRoutes).route("/", bootTimingRoutes);
app.route("/api", api);
app.all("/api", terminalRoute("/api", (c) => c.json({ error: "Not found" }, 404)));
app.all("/api/*", terminalRoute("/api/*", (c) => c.json({ error: "Not found" }, 404)));
const media = new Hono<AppEnv>(); media.use("/*", mediaNoStoreByDefault); media.use("/*", requireSession); media.route("/", mediaRoutes); app.route("/media", media);
app.all("/media", terminalRoute("/media", (c) => c.json({ error: "Not found" }, 404)));
app.all("/media/*", terminalRoute("/media/*", (c) => c.json({ error: "Not found" }, 404)));
app.all("/__transform-source", terminalRoute("/__transform-source", (c) => c.notFound()));
app.get("/__transform-source/*", terminalRoute("/__transform-source/*", async (c) => {
  let key: string;
  try { key = decodeURIComponent(c.req.path.slice("/__transform-source/".length)); }
  catch { return c.notFound(); }
  // A staff Video original or poster is never an Images source (#741): its bytes are served by the Video routes alone.
  if (VIDEO_KEY_PATTERN.test(key)) return c.notFound();
  const query = new URL(c.req.url).searchParams;
  // A signed source has one canonical query shape. Reject extra/duplicate fields so a bearer
  // cannot manufacture distinct Images cache keys during its authorized source-fetch window.
  const names = [...query.keys()].sort();
  if (names.join(",") !== "ae,exp,p,sig,v") return c.notFound();
  if (!await verifyTransformSource(c.env, key, query.get("sig") ?? undefined, query.get("exp") ?? undefined, query.get("p") ?? undefined, query.get("ae") ?? undefined, query.get("v") ?? undefined)) return c.notFound();
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.notFound();
  // The source URL is no-store, but Images may retain a transformed result after this HMAC
  // expires. The redirect is therefore a short-lived bearer with effective lifetime set by
  // Cloudflare's transform cache, not an auth-revocation mechanism. Remove this fallback only
  // once durable renditions are fully populated; do not proxy it (same-zone bypass recurs).
  const contentType = object.httpMetadata?.contentType ?? (/\.dng$/i.test(key) ? "image/x-adobe-dng" : "image/jpeg");
  const headers: Record<string, string> = { "content-type": contentType, "cache-control": "private, no-store", "content-length": String(object.size), "x-content-type-options": "nosniff" };
  if (object.httpEtag) headers.etag = object.httpEtag;
  return new Response(object.body, { headers });
}));
// MCP door (#702): outside `/api` (router-wide middleware leaks across sibling mounts), before the SPA fallback.
mountMcp(app, (request, env, ctx) => app.fetch(request, env, ctx));
// Signed MCP downloads (#707): outside `/api` for the same reason, no cookie CORS. Redemption dispatches back through `app.fetch`.
mountMcpDownloads(app, (request, env, ctx) => app.fetch(request, env, ctx));
// `/d` is reserved for the future client-delivery Worker. It is intentionally
// unauthenticated and must run before the static-asset SPA fallback.
// The guest surface (#741 12a) mounts first; everything it does not answer falls through to the stub below (same bytes, hygiene headers included).
mountGuest(app);
app.all("/d", terminalRoute("/d", (c) => guestNotFound(c)));
app.all("/d/*", terminalRoute("/d/*", (c) => guestNotFound(c)));
// #359: `/assets/*` is content-hashed and served `immutable` for a year (`apps/web/public/_headers`).
// `/assets/*` is in `run_worker_first` (wrangler.jsonc) so a MISS reaches this Worker instead of the
// asset layer's `single-page-application` fallback answering it with index.html, which the immutable
// rule would let a browser cache under a hashed URL for a year. Existing files still pass through
// ASSETS.fetch with `_headers` applied; a miss (HTML fallback) becomes a `no-store` 404.
app.all("*", terminalRoute("*", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (new URL(c.req.url).pathname.startsWith("/assets/") && (response.headers.get("content-type") ?? "").includes("text/html")) {
    await response.body?.cancel();
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  }
  return response;
}));
export { ProjectWhiteboardDO } from "./whiteboard/project-whiteboard-do";
export default { fetch: (request: Request, env: Env, ctx: ExecutionContext) => fetchWithServerTiming(app.fetch, request, env, ctx) };
