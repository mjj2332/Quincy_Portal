import { Hono } from "hono";
import { terminalRoute } from "./lib/terminal-route";
import { cors } from "hono/cors";
import { externalMeResponseSchema, ROLE_CAPABILITIES } from "@quincy/shared";
import type { AppEnv } from "./env";
import { createAuth } from "./auth";
import { requireSession } from "./middleware/session";
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
import { projectSubtasksRoutes } from "./routes/project-subtasks";
import { projectDeadlineRoutes } from "./routes/project-deadline";
import { notificationPreferencesRoutes } from "./routes/notification-preferences";
import { externalUploadsRoutes } from "./routes/external-uploads";
import { projectAccessSnapshotRoutes } from "./routes/project-access-snapshot";
import { verifyTransformSource } from "./lib/transform-source";
import { requireAppOrigin } from "./middleware/origin";
import { safeStaffDestination } from "@quincy/shared";

export const app = new Hono<AppEnv>();
app.use("/api/*", async (c, next) => cors({ origin: c.env.APP_ORIGIN, credentials: true, allowHeaders: ["content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] })(c, next));
// Scope this middleware to /api explicitly: router-wide '*' middleware mounted at
// '/' can leak into sibling routes (see docs/lessons.md).
app.use("/api", requireAppOrigin);
app.use("/api/*", requireAppOrigin);
app.get("/api/health", terminalRoute("/api/health", (c) => c.json({ ok: true, env: c.env.APP_ENV })));
app.all("/api/auth/sign-in/social", terminalRoute("/api/auth/sign-in/social", async (c) => {
  if (c.req.method !== "POST") return createAuth(c.env).handler(c.req.raw);
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
  return createAuth(c.env).handler(c.req.raw);
}));
app.post("/api/auth/admin/impersonate-user", requireSession, requireCapability("manageUsers"), requireImpersonationEnabled, terminalRoute("/api/auth/admin/impersonate-user", (c) => createAuth(c.env).handler(c.req.raw)));
app.post("/api/auth/admin/impersonate-user/", requireSession, requireCapability("manageUsers"), requireImpersonationEnabled, terminalRoute("/api/auth/admin/impersonate-user/", (c) => createAuth(c.env).handler(c.req.raw)));
app.all("/api/auth/*", terminalRoute("/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw)));
const api = new Hono<AppEnv>();
api.use("/*", requireSession);
api.get("/me", terminalRoute("/me", (c) => { const user = c.get("user"); const response = { user, capabilities: [...(ROLE_CAPABILITIES[user.role] ?? [])] }; return c.json(user.role === "external_editor" ? externalMeResponseSchema.parse(response) : response); }));
api.route("/", usersRoutes).route("/", projectsRoutes).route("/", projectDeadlineRoutes).route("/", notificationPreferencesRoutes).route("/", externalUploadsRoutes).route("/", uploadsRoutes).route("/", collectionsRoutes).route("/", integrationsRoutes).route("/", reviewRoutes).route("/", annotationsRoutes).route("/", stagesRoutes).route("/", adminRoutes).route("/", noticeBoardRoutes).route("/", mentionableUsersRoutes).route("/", projectCommentsRoutes).route("/", projectSubtasksRoutes).route("/", notificationsRoutes).route("/", assetsRoutes).route("/", projectAccessSnapshotRoutes);
app.route("/api", api);
app.all("/api", terminalRoute("/api", (c) => c.json({ error: "Not found" }, 404)));
app.all("/api/*", terminalRoute("/api/*", (c) => c.json({ error: "Not found" }, 404)));
const media = new Hono<AppEnv>(); media.use("/*", requireSession); media.route("/", mediaRoutes); app.route("/media", media);
app.all("/media", terminalRoute("/media", (c) => c.json({ error: "Not found" }, 404)));
app.all("/media/*", terminalRoute("/media/*", (c) => c.json({ error: "Not found" }, 404)));
app.all("/__transform-source", terminalRoute("/__transform-source", (c) => c.notFound()));
app.get("/__transform-source/*", terminalRoute("/__transform-source/*", async (c) => {
  let key: string;
  try { key = decodeURIComponent(c.req.path.slice("/__transform-source/".length)); }
  catch { return c.notFound(); }
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
  const headers: Record<string, string> = { "content-type": "image/jpeg", "cache-control": "private, no-store", "content-length": String(object.size), "x-content-type-options": "nosniff" };
  if (object.httpEtag) headers.etag = object.httpEtag;
  return new Response(object.body, { headers });
}));
// `/d` is reserved for the future client-delivery Worker. It is intentionally
// unauthenticated and must run before the static-asset SPA fallback.
app.all("/d", terminalRoute("/d", (c) => c.notFound()));
app.all("/d/*", terminalRoute("/d/*", (c) => c.notFound()));
app.all("*", terminalRoute("*", (c) => c.env.ASSETS.fetch(c.req.raw)));
export default { fetch: app.fetch };
