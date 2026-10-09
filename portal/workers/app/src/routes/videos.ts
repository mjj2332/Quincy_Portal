import { Hono } from "hono";
import { z } from "zod";
import { VIDEO_REVIEW_PART_CAPABILITY, roleHasCapability, videoReviewResponseSchema } from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { readVideoReviewGate } from "../lib/video-review-gate";

const uuid = z.string().uuid();

/**
 * Staff video review (#741). Every route here is checked inline, in this order: malformed id 400, then
 * Project visibility (an External editor outside the Project 404, staff 403, as everywhere else), then the
 * gate, then the capability. No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md).
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
