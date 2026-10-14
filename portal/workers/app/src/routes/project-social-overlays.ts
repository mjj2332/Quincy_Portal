import { Hono, type Context } from "hono";
import { z } from "zod";
import { projectSocialOverlayInput, roleHasCapability } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { readProjectSocialOverlays, setProjectSocialOverlays } from "../lib/project-social-overlays";
import { terminalRoute } from "../lib/terminal-route";
import { principalOf } from "./helpers";
import { readVideoReviewGate } from "../lib/video-review-gate";

const uuid = z.string().uuid();
const BODY_MAX = 16 * 1024;
type Ctx = Context<AppEnv>;

/**
 * A Project's Social overlays (#870). Checked inline, in this order: malformed id 400, the video review gate (closed 404, no part of its own), the capability 403 (`viewVideo` to read,
 * `chooseSocialOverlays` to set), Project visibility (an External outside the Project 404, staff 403), then for PUT the body (413 over 16 KiB, 400 malformed), archived (409 `project_archived`)
 * and the write. An assigned External editor reads but never sets. No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md). Every answer is private and no-store.
 */
export const projectSocialOverlayRoutes = new Hono<AppEnv>();

const noAccess = (c: Ctx) => c.get("user").role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);

async function admit(c: Ctx, capability: "viewVideo" | "chooseSocialOverlays"): Promise<{ projectId: string } | Response> {
  const projectId = c.req.param("projectId") ?? "";
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid id" }, 400);
  if (!(await readVideoReviewGate(c.env.DB, projectId)).open) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(c.get("user").role, capability)) return c.json({ error: "Forbidden", capability }, 403);
  if (!await hasProjectAccess(c, projectId)) return noAccess(c);
  return { projectId };
}

projectSocialOverlayRoutes.get("/projects/:projectId/social-overlays", terminalRoute("/projects/:projectId/social-overlays", async (c) => {
  const admitted = await admit(c, "viewVideo"); if (admitted instanceof Response) return admitted;
  c.header("cache-control", "private, no-store");
  return c.json(await readProjectSocialOverlays(c.env.DB, admitted.projectId));
}));

projectSocialOverlayRoutes.put("/projects/:projectId/social-overlays", terminalRoute("/projects/:projectId/social-overlays", async (c) => {
  const admitted = await admit(c, "chooseSocialOverlays"); if (admitted instanceof Response) return admitted;
  c.header("cache-control", "private, no-store");
  const declared = Number(c.req.header("content-length") ?? "0");
  const text = declared > BODY_MAX ? null : await c.req.text();
  if (text === null || text.length > BODY_MAX) return c.json({ error: "Request body too large", code: "body_too_large" }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const input = projectSocialOverlayInput.safeParse(body);
  if (!input.success) return c.json({ error: "Invalid input", details: input.error.flatten() }, 400);
  const user = c.get("user");
  const outcome = await setProjectSocialOverlays(c.env.DB, { projectId: admitted.projectId, ...input.data, principal: principalOf(c), now: Date.now() });
  switch (outcome.kind) {
    case "set": return c.json(outcome.state);
    case "conflict": return c.json({ error: "The Project's Social overlays changed since you looked.", code: "social_overlays_conflict", current: outcome.state }, 409);
    case "archived": return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Archived projects are read-only; the Social overlays can't be changed.", code: "project_archived" }, 409);
    case "unavailable": return c.json({ error: "One of those overlays is not available.", code: "overlay_unavailable" }, 409);
    case "not_found": return c.json({ error: "Project not found" }, 404);
  }
}));
