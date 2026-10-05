import { Hono } from "hono";
import { z } from "zod";
import { linkPreviewRequestSchema, linkPreviewResponseSchema } from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { requestLinkPreview } from "../lib/link-previews";
import { jsonInput } from "./helpers";
import { collaborationGate } from "./embedded-media";

/** The Portal's own host names, which a preview must never fetch (the request's host and the configured origin). */
export function ownHosts(c: { req: { url: string }; env: AppEnv["Bindings"] }): string[] {
  const hosts = new Set<string>();
  for (const value of [c.req.url, c.env.APP_ORIGIN]) { try { hosts.add(new URL(value).hostname); } catch { /* an unset origin names nothing */ } }
  return [...hosts];
}

export const linkPreviewRoutes = new Hono<AppEnv>();

/**
 * Link preview for a Project comment (#497). The same gate as the Project's embedded media: 403 for staff outside the Project,
 * 404 for an External editor who is not assigned, 409 once the Project is archived. The Notice board's route sits beside its posts.
 */
linkPreviewRoutes.post("/projects/:projectId/link-previews", terminalRoute("/projects/:projectId/link-previews", async (c) => {
  const projectId = c.req.param("projectId"); if (!z.string().uuid().safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  if (project.archivedAt) return c.json({ error: "Archived projects cannot take link previews", code: "project_archived" }, 409);
  const data = await jsonInput(c, linkPreviewRequestSchema); if (data instanceof Response) return data;
  const result = await requestLinkPreview(c.env, c.get("user"), { ownerKind: "project_comment", projectId }, data.url, ownHosts(c));
  return result.status === 200 ? c.json(linkPreviewResponseSchema.parse(result.body)) : c.json(result.body, result.status);
}));
