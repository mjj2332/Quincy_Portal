import { Hono } from "hono";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { isSupportedWhiteboardProtocol, simplifyScene, WHITEBOARD_VERSIONS_RETAINED, whiteboardRestoreRequestSchema, whiteboardServerEditsRequestSchema, type StoredElement, type WhiteboardMediaInfo, type WhiteboardMode, type WhiteboardVersionsResponse } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectCollaborationAccess } from "../middleware/capability";
import { audit } from "../lib/audit";
import { terminalRoute } from "../lib/terminal-route";
import { WHITEBOARD_MODE_HEADER, WHITEBOARD_NAME_HEADER, WHITEBOARD_PROJECT_HEADER, WHITEBOARD_USER_HEADER } from "../whiteboard/project-whiteboard-do";

const projectIdSchema = z.string().uuid();
const versionIdSchema = z.string().uuid();

export const projectWhiteboardRoutes = new Hono<AppEnv>();

/**
 * #498 (ADR 0017): the Project whiteboard's WebSocket upgrade. Authorisation happens HERE, before
 * a Durable Object is ever addressed, so a refused request creates none:
 *   session (the `api` router's `requireSession`) -> Origin -> collaboration access -> Project row
 *   -> Upgrade header -> protocol (#501) -> mode from the Project's archived state.
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
  // #501: a tab loaded before images and videos existed would sweep every image element and author its deletion for everyone, so it never joins.
  if (!isSupportedWhiteboardProtocol(c.req.query("protocol"))) return c.json({ error: "This page is out of date. Reload it to open the whiteboard.", code: "client_outdated" }, 426);
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
    `SELECT v.id AS id, v.created_at AS createdAt, v.created_by AS createdById, u.name AS createdByName, v.reason AS reason, v.element_count AS elementCount, v.byte_count AS byteCount, v.scene_sha256 AS sceneSha256
     FROM project_whiteboard_versions v LEFT JOIN user u ON u.id = v.created_by
     WHERE v.project_id = ? AND v.state = 'ready' ORDER BY v.ordinal DESC LIMIT ?`,
  ).bind(projectId, WHITEBOARD_VERSIONS_RETAINED).all<{ id: string; createdAt: number; createdById: string | null; createdByName: string | null; reason: "interval" | "last_leave" | "pre_restore"; elementCount: number; byteCount: number; sceneSha256: string }>()).results;
  const stub = c.env.PROJECT_WHITEBOARD.get(c.env.PROJECT_WHITEBOARD.idFromName(projectId));
  const [generation, liveSha] = await Promise.all([stub.currentGeneration(), stub.currentSceneSha256()]);
  const body: WhiteboardVersionsResponse = {
    generation,
    // #559: the newest version whose content hash equals the live board's (rows are newest first), or none when the board has moved on since its last snapshot.
    currentVersionId: rows.find((row) => row.sceneSha256 === liveSha)?.id ?? null,
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

/**
 * #708: the board as a plain list for the MCP server (and any client that wants no Excalidraw): one entry per live element, with
 * the board generation an edit must quote. Same access decision as the versions listing. The generation and the rows come from
 * one Durable Object call, so they describe the same moment.
 */
projectWhiteboardRoutes.get("/projects/:projectId/whiteboard", terminalRoute("/projects/:projectId/whiteboard", async (c) => {
  const parsed = projectIdSchema.safeParse(c.req.param("projectId"));
  if (!parsed.success) return c.json({ error: "Invalid project id" }, 400);
  const projectId = parsed.data;
  const denied = await deniedWhiteboardAccess(c, projectId);
  if (denied) return c.json(denied.body, denied.status);
  const project = await createDb(c.env.DB).select({ archivedAt: schema.projects.archivedAt }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  const stub = c.env.PROJECT_WHITEBOARD.get(c.env.PROJECT_WHITEBOARD.idFromName(projectId));
  const scene = await stub.currentScene();
  return c.json({ generation: scene.generation, archived: project.archivedAt !== null, elements: simplifyScene(JSON.parse(scene.elementsJson) as StoredElement[]) });
}));

/**
 * #708: an MCP client's edits to the board. The route authorises (collaboration access, as above), validates the strict command
 * set, resolves the Embedded media a `place_media` edit names (this Project's whiteboard media only) and hands the Durable Object
 * the typed `applyServerEdits`; the object re-authorises and applies every fence. A successful edit is audited as the effective
 * user, with the MCP provenance `auditMeta` adds. No socket is faked: the object broadcasts from a synthetic session.
 */
projectWhiteboardRoutes.post("/projects/:projectId/whiteboard/server-edits", terminalRoute("/projects/:projectId/whiteboard/server-edits", async (c) => {
  const parsed = projectIdSchema.safeParse(c.req.param("projectId"));
  if (!parsed.success) return c.json({ error: "Invalid project id" }, 400);
  const projectId = parsed.data;
  const denied = await deniedWhiteboardAccess(c, projectId);
  if (denied) return c.json(denied.body, denied.status);
  let json: unknown;
  try { json = await c.req.json(); } catch { return c.json({ error: "Invalid request body" }, 400); }
  const body = whiteboardServerEditsRequestSchema.safeParse(json);
  if (!body.success) return c.json({ error: "Invalid request body", issues: body.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, 400);
  const project = await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) return c.json({ error: "Project not found" }, 404);
  const mediaIds = [...new Set(body.data.edits.flatMap((edit) => edit.op === "place_media" ? [edit.embeddedMediaId] : []))];
  const media: Record<string, WhiteboardMediaInfo> = {};
  if (mediaIds.length > 0) {
    const rows = (await c.env.DB.prepare(
      `SELECT id, kind, COALESCE(width, display_width) AS width, COALESCE(height, display_height) AS height FROM embedded_media
       WHERE project_id = ? AND owner_kind = 'whiteboard' AND kind IN ('image', 'video') AND state != 'uploading' AND id IN (SELECT value FROM json_each(?))`,
    ).bind(projectId, JSON.stringify(mediaIds)).all<{ id: string; kind: "image" | "video"; width: number | null; height: number | null }>()).results;
    for (const row of rows) media[row.id] = { kind: row.kind, width: row.width, height: row.height };
  }
  const user = c.get("user");
  const requestId = crypto.randomUUID();
  const stub = c.env.PROJECT_WHITEBOARD.get(c.env.PROJECT_WHITEBOARD.idFromName(projectId));
  const result = await stub.applyServerEdits({
    projectId, expectedGeneration: body.data.expectedGeneration, requestId, edits: body.data.edits, media,
    actor: { id: user.id, name: user.name, impersonatedBy: user.impersonatedBy, via: user.via ? { clientName: user.via.clientName } : null },
  });
  if (!result.ok) return c.json({ error: result.message, code: result.code, ...(result.generation === undefined ? {} : { generation: result.generation }) }, result.status);
  const ops: Record<string, number> = {};
  for (const edit of body.data.edits) ops[edit.op] = (ops[edit.op] ?? 0) + 1;
  try {
    await audit(c.env, user, "project_whiteboard.server_edit", "project", projectId, { requestId, generation: result.generation, editCount: body.data.edits.length, ops, elementIds: result.results.map((entry) => entry.id) });
  } catch (error) {
    // The edit is on the board and cannot be taken back; a thrown audit would only make the client repeat it.
    console.error("whiteboard server edit audit failed", { event: "project_whiteboard_server_edit_audit_failed", projectId, requestId, message: error instanceof Error ? error.message : String(error) });
  }
  return c.json({ generation: result.generation, applied: result.results });
}));
