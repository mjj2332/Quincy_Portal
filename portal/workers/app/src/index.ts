import { Hono } from "hono";
import { cors } from "hono/cors";
import { ROLE_CAPABILITIES } from "@quincy/shared";
import type { AppEnv } from "./env";
import { createAuth } from "./auth";
import { requireSession } from "./middleware/session";
import { usersRoutes } from "./routes/users";
import { projectsRoutes } from "./routes/projects";
import { uploadsRoutes } from "./routes/uploads";
import { integrationsRoutes } from "./routes/integrations";
import { reviewRoutes } from "./routes/review";
import { mediaRoutes } from "./routes/media";
import { annotationsRoutes } from "./routes/annotations";
import { adminRoutes } from "./routes/admin";
import { stagesRoutes } from "./routes/stages";
import { verifyTransformSource } from "./lib/transform-source";

const app = new Hono<AppEnv>();
app.use("/api/*", async (c, next) => cors({ origin: c.env.APP_ORIGIN, credentials: true, allowHeaders: ["content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] })(c, next));
app.get("/api/health", (c) => c.json({ ok: true, env: c.env.APP_ENV }));
app.all("/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
const api = new Hono<AppEnv>();
api.use("/*", requireSession);
api.get("/me", (c) => { const user = c.get("user"); return c.json({ user, capabilities: [...ROLE_CAPABILITIES[user.role]] }); });
api.route("/", usersRoutes).route("/", projectsRoutes).route("/", uploadsRoutes).route("/", integrationsRoutes).route("/", reviewRoutes).route("/", annotationsRoutes).route("/", stagesRoutes).route("/", adminRoutes);
app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
const media = new Hono<AppEnv>(); media.use("/*", requireSession); media.route("/", mediaRoutes); app.route("/media", media);
app.all("/media/*", (c) => c.json({ error: "Not found" }, 404));
app.get("/__transform-source/*", async (c) => {
  let key: string;
  try { key = decodeURIComponent(c.req.path.slice("/__transform-source/".length)); }
  catch { return c.notFound(); }
  if (!await verifyTransformSource(c.env, key, c.req.query("sig"))) return c.notFound();
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, { headers: { "content-type": "image/jpeg" } });
});
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
export default { fetch: app.fetch };
