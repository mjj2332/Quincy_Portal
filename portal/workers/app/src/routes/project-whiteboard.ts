import { Hono } from "hono";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { WHITEBOARD_VERSIONS_RETAINED, whiteboardRestoreRequestSchema, type WhiteboardMode, type WhiteboardVersionsResponse } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { terminalRoute } from "../lib/terminal-route";
import { WHITEBOARD_MODE_HEADER, WHITEBOARD_NAME_HEADER, WHITEBOARD_PROJECT_HEADER, WHITEBOARD_USER_HEADER } from "../whiteboard/project-whiteboard-do";

const projectIdSchema = z.string().uuid();
const versionIdSchema = z.string().uuid();

export const projectWhiteboardRoutes = new Hono<AppEnv>();

/**
 * #498 (ADR 0017): the Project whiteboard's WebSocket upgrade. Authorisation happens HERE, before
 * a Durable Object is ever addressed, so a refused request creates none:
 *   session (the `api` router's `requireSession`) -> Origin -> collaboration access -> Project row
 *   -> Upgrade header -> mode from the Project's archived state.
 * The Origin check is explicit because `requireAppOrigin` only guards unsafe methods and a
 * WebSocket handshake is a GET: without it any site could open a socket with the user's cookie.
 * The Durable Object receives identity, mode and the display name (URI-encoded: a header is a
 * ByteString) through headers set on a FRESH Request, so nothing the browser sent can reach it.
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
    headers: { Upgrade: "websocket", [WHITEBOARD_USER_HEADER]: user.id, [WHITEBOARD_MODE_HEADER]: mode, [WHITEBOARD_PROJECT_HEADER]: projectId, [WHITEBOARD_NAME_HEADER]: encodeURIComponent(user.name) },
  }));
}));

/**
 * #500: the same access decision as the socket (collaboration access; an External editor who may not see the Project is told
 * 404, never 403), shared by both version routes. A refused request creates no Durable Object.
 */
async function deniedWhiteboardAccess(c: Parameters<typeof hasProjectCollaborationAccess>[0], projectId: string) {
  if (await hasProjectCollaborationAccess(c, projectId)) return null;
  return c.get("user").role === "external_editor"
    ? { status: 404 as const, body: { error: "Project not found" } }
    : { status: 403 as const, body: { error: "Forbidden: you are not assigned to this project" } };
}

/**
 * #500: the board's history, newest first. Anyone with collaboration access may browse it, an Archived Project's included (the
 * board is view-only there, restoring is not). Only `ready` versions are offered: a `pruning` one is on its way out.
 */
projectWhiteboardRoutes.get("/projects/:projectId/whiteboard/versions", terminalRoute("/projects/:projectId/whiteboard/versions", async (c) => {
  const parsed = projectIdSchema.safeParse(c.req.param("projectId"));
  if (!parsed.success) return c.json({ error: "Invalid project id" }, 400);
  const projectId = parsed.data;
  const denied = await deniedWhiteboardAccess(c, projectId);
  if (denied) return c.json(denied.body, denied.status);
  const project = await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  const rows = (await c.env.DB.prepare(
    `SELECT v.id AS id, v.created_at AS createdAt, v.created_by AS createdById, u.name AS createdByName, v.reason AS reason, v.element_count AS elementCount, v.byte_count AS byteCount
     FROM project_whiteboard_versions v LEFT JOIN user u ON u.id = v.created_by
     WHERE v.project_id = ? AND v.state = 'ready' ORDER BY v.ordinal DESC LIMIT ?`,
  ).bind(projectId, WHITEBOARD_VERSIONS_RETAINED).all<{ id: string; createdAt: number; createdById: string | null; createdByName: string | null; reason: "interval" | "last_leave" | "pre_restore"; elementCount: number; byteCount: number }>()).results;
  const stub = c.env.PROJECT_WHITEBOARD.get(c.env.PROJECT_WHITEBOARD.idFromName(projectId));
  const generation = await stub.currentGeneration();
  const body: WhiteboardVersionsResponse = {
    generation,
    versions: rows.map((row) => ({ id: row.id, createdAt: row.createdAt, createdBy: row.createdById === null ? null : { id: row.createdById, name: row.createdByName ?? "" }, reason: row.reason, elementCount: row.elementCount, byteCount: row.byteCount })),
  };
  return c.json(body);
}));

/**
 * #500: restores a version. The route authorises (collaboration access, as above) and validates; the Durable Object then re-checks
 * access and archive state, backs the current scene up, swaps the rows and bumps the generation (see `restoreVersion`). The effective
 * user (an Admin impersonating someone acts AS them, with `impersonatedBy` kept for the audit) is the actor: there is no Admin override.
 */
projectWhiteboardRoutes.post("/projects/:projectId/whiteboard/versions/:versionId/restore", terminalRoute("/projects/:projectId/whiteboard/versions/:versionId/restore", async (c) => {
  const project = projectIdSchema.safeParse(c.req.param("projectId"));
  const version = versionIdSchema.safeParse(c.req.param("versionId"));
  if (!project.success) return c.json({ error: "Invalid project id" }, 400);
  if (!version.success) return c.json({ error: "Invalid version id" }, 400);
  const denied = await deniedWhiteboardAccess(c, project.data);
  if (denied) return c.json(denied.body, denied.status);
  let json: unknown;
  try { json = await c.req.json(); } catch { return c.json({ error: "Invalid request body" }, 400); }
  const body = whiteboardRestoreRequestSchema.safeParse(json);
  if (!body.success) return c.json({ error: "Invalid request body" }, 400);
  const user = c.get("user");
  const stub = c.env.PROJECT_WHITEBOARD.get(c.env.PROJECT_WHITEBOARD.idFromName(project.data));
  const result = await stub.restoreVersion({ projectId: project.data, versionId: version.data, expectedGeneration: body.data.expectedGeneration, requestId: body.data.requestId, actor: { id: user.id, impersonatedBy: user.impersonatedBy } });
  if (result.ok) return c.json(result);
  return c.json({ error: result.message, code: result.code, ...(result.generation === undefined ? {} : { generation: result.generation }) }, result.status);
}));
