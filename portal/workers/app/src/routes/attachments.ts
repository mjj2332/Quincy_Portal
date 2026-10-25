import { Hono, type Context } from "hono";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { ATTACHMENT_MAX_BYTES, attachmentPresignInput } from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import type { UploadScope } from "../lib/embedded-media-upload";
import { abortAttachmentUpload, completeAttachment, directAttachment, presignAttachment } from "../lib/attachment-upload";
import { collaborationGate } from "./embedded-media";
import { jsonInput } from "./helpers";

/**
 * Attachments on a Project's discussion (#952): presign, the dev direct PUT, complete and abort. The people are the Collaboration tab's, as for Embedded media (owner decision A1:
 * External editors on the Project too), through the same `collaborationGate` (staff off the Project 403, an External outside it 404). The download is `GET /media/attachments/:id`.
 */
const uuid = z.string().uuid();
const completeInput = z.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }).strict()).optional() }).strict();
const invalid = (c: Context<AppEnv>) => c.json({ error: "Invalid file upload" }, 400);
const archivedReply = (c: Context<AppEnv>) => c.json({ error: "Archived projects cannot accept files", code: "project_archived" }, 409);
const stray = (c: Context<AppEnv>) => c.json({ error: "File upload not found" }, 404);

export const attachmentRoutes = new Hono<AppEnv>();

/** The upload core's scope for this staff request: the signed-in user uploads, no extra fence, and audit rows name them (an impersonating Admin is stamped). */
function scopeOf(c: Context<AppEnv>, projectId: string): UploadScope {
  const user = c.get("user");
  return { env: c.env, projectId, uploader: { userId: user.id }, audit: (action, attachmentId, meta) => audit(c.env, user, action, "attachment", attachmentId, meta) };
}

const projectExists = async (c: Context<AppEnv>, projectId: string) => Boolean(await createDb(c.env.DB).select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).get());

attachmentRoutes.post("/projects/:projectId/attachments", terminalRoute("/projects/:projectId/attachments", async (c) => {
  const projectId = c.req.param("projectId"); if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid project id" }, 400);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  if (project.archivedAt) return archivedReply(c);
  const data = await jsonInput(c, attachmentPresignInput); if (data instanceof Response) return data;
  return presignAttachment(scopeOf(c, projectId), { ...data, ownerKind: "project_comment", maxBytes: ATTACHMENT_MAX_BYTES });
}));

attachmentRoutes.put("/projects/:projectId/attachments/:attachmentId/direct", terminalRoute("/projects/:projectId/attachments/:attachmentId/direct", async (c) => {
  if (c.env.APP_ENV !== "dev") return c.json({ error: "Direct uploads are available only in dev" }, 404);
  const projectId = c.req.param("projectId"); const attachmentId = c.req.param("attachmentId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(attachmentId).success) return invalid(c);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  if (project.archivedAt) return archivedReply(c);
  return directAttachment(scopeOf(c, projectId), attachmentId, c.req.raw.body);
}));

attachmentRoutes.post("/projects/:projectId/attachments/:attachmentId/complete", terminalRoute("/projects/:projectId/attachments/:attachmentId/complete", async (c) => {
  const projectId = c.req.param("projectId"); const attachmentId = c.req.param("attachmentId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(attachmentId).success) return invalid(c);
  // A row whose Project is gone is not ours to clean up: the hard delete queued its keys before the cascade.
  if (!await projectExists(c, projectId)) return stray(c);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  if (project.archivedAt) return archivedReply(c);
  const data = await jsonInput(c, completeInput); if (data instanceof Response) return data;
  return completeAttachment(scopeOf(c, projectId), attachmentId, data);
}));

/** A cancelled upload: the uploader's alone, in any Project state, since cleaning up is never harmful. */
attachmentRoutes.post("/projects/:projectId/attachments/:attachmentId/abort", terminalRoute("/projects/:projectId/attachments/:attachmentId/abort", async (c) => {
  const projectId = c.req.param("projectId"); const attachmentId = c.req.param("attachmentId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(attachmentId).success) return invalid(c);
  if (!await projectExists(c, projectId)) return stray(c);
  const project = await collaborationGate(c, projectId); if (project instanceof Response) return project;
  return abortAttachmentUpload(scopeOf(c, projectId), attachmentId);
}));
