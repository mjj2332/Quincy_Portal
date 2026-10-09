import { Hono } from "hono";
import { z } from "zod";
import { VIDEO_REVIEW_PART_CAPABILITY, roleHasCapability, videoListResponseSchema, videoReviewResponseSchema } from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { loadVideoDtos } from "../lib/video-dto";
import { readVideoReviewGate, videoReviewGate } from "../lib/video-review-gate";

const uuid = z.string().uuid();

/**
 * Staff video review (#741). Every route here is checked inline, in this order: malformed id 400, then the
 * gate (closed 404), then the capability (403), then Project visibility (an External editor outside the Project 404, staff 403, as everywhere else). No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md).
 */
export const videosRoutes = new Hono<AppEnv>();

/**
 * What video review this caller has on this Project. A closed gate is 200 `{ open: false, parts: [] }`
 * so the web needs no 404 branch; the routes behind a part answer 404 themselves. `open` and `parts` are
 * intersected with the caller's capabilities, so a Photographer always reads closed.
 */
videosRoutes.get("/projects/:projectId/video-review", terminalRoute("/projects/:projectId/video-review", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  if (!await hasProjectAccess(c, projectId)) return c.get("user").role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  const role = c.get("user").role;
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  const open = gate.open && roleHasCapability(role, "viewVideo");
  return c.json(videoReviewResponseSchema.parse({ open, parts: open ? gate.parts.filter((part) => roleHasCapability(role, VIDEO_REVIEW_PART_CAPABILITY[part])) : [] }));
}));

/**
 * The Project's Videos with every Version embedded, newest first (no separate versions route). Three reads in one batch: the Videos,
 * their Versions joined to the probed meta and the uploader, and the upload in flight. The gate is the open check alone (`null`): there is
 * no "view" part, and viewing must survive the operator turning `upload` off. The list is the same strict shape for every role; it never
 * carries an object key, only the `/media/video/:assetId` addresses a Version is played from.
 */
videosRoutes.get("/projects/:projectId/videos", terminalRoute("/projects/:projectId/videos", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const user = c.get("user");
  if (!await videoReviewGate(c.env.DB, projectId, null)) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "viewVideo")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  return c.json(videoListResponseSchema.parse({ videos: await loadVideoDtos(c.env.DB, projectId) }));
}));
