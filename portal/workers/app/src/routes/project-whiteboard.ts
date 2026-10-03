import { Hono } from "hono";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { WhiteboardMode } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { terminalRoute } from "../lib/terminal-route";
import { WHITEBOARD_MODE_HEADER, WHITEBOARD_USER_HEADER } from "../whiteboard/project-whiteboard-do";

const projectIdSchema = z.string().uuid();

export const projectWhiteboardRoutes = new Hono<AppEnv>();

/**
 * #498 (ADR 0017): the Project whiteboard's WebSocket upgrade. Authorisation happens HERE, before
 * a Durable Object is ever addressed, so a refused request creates none:
 *   session (the `api` router's `requireSession`) -> Origin -> collaboration access -> Project row
 *   -> Upgrade header -> mode from the Project's archived state.
 * The Origin check is explicit because `requireAppOrigin` only guards unsafe methods and a
 * WebSocket handshake is a GET: without it any site could open a socket with the user's cookie.
 * The Durable Object receives identity and mode through headers set on a FRESH Request, so nothing
 * the browser sent can reach it.
 */
projectWhiteboardRoutes.get("/projects/:projectId/whiteboard/socket", terminalRoute("/projects/:projectId/whiteboard/socket", async (c) => {
  const parsed = projectIdSchema.safeParse(c.req.param("projectId"));
  if (!parsed.success) return c.json({ error: "Invalid project id" }, 400);
  const projectId = parsed.data;
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.json({ error: "Forbidden: invalid request origin" }, 403);
  const user = c.get("user");
  if (!await hasProjectCollaborationAccess(c, projectId)) {
    return user.role === "external_editor"
      ? c.json({ error: "Project not found" }, 404)
      : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  }
  const project = await createDb(c.env.DB).select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Expected a WebSocket upgrade" }, 426);
  const mode: WhiteboardMode = project.archivedAt ? "view" : "edit";
  const stub = c.env.PROJECT_WHITEBOARD.get(c.env.PROJECT_WHITEBOARD.idFromName(projectId));
  return stub.fetch(new Request("https://whiteboard.internal/socket", {
    headers: { Upgrade: "websocket", [WHITEBOARD_USER_HEADER]: user.id, [WHITEBOARD_MODE_HEADER]: mode },
  }));
}));
