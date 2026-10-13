import { Hono, type Context } from "hono";
import { z } from "zod";
import { normalizeVideoUploadFilename, roleHasCapability, videoRenameInputSchema, videoRenameResponseSchema } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { readVideoReviewGate } from "../lib/video-review-gate";
import { loadVideoDtos } from "../lib/video-dto";
import { renameVersion } from "../lib/video-rename";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Rename a Video (#867). Checked inline, in this order: malformed id 400, the video review gate (closed 404, no part of its own), the `uploadVideo` capability 403 (whoever can upload can already
 * retitle by uploading), Project visibility (an External outside the Project 404, staff 403), archived (staff 409, an External 404), the strict body 400, the Version 404, then a Version that is
 * no longer the latest 409 `not_latest_version` with the fresh Video. The path names the Version the dialog was opened on, so an upload that landed in between is never renamed by mistake. A `.mov`
 * is stored as `.mp4` as upload does. No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md).
 */
export const videoRenameRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const archivedResponse = (c: Ctx) => c.get("user").role === "external_editor"
  ? c.json({ error: "Project not found" }, 404)
  : c.json({ error: "Archived projects are read-only; the file name can't be changed.", code: "project_archived" }, 409);

videoRenameRoutes.put("/projects/:projectId/video-versions/:assetId/file-name", terminalRoute("/projects/:projectId/video-versions/:assetId/file-name", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId"); const user = c.get("user");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.open) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "uploadVideo")) return c.json({ error: "Forbidden", capability: "uploadVideo" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  const input = await jsonInput(c, videoRenameInputSchema); if (input instanceof Response) return input;
  const outcome = await renameVersion(c.env.DB, { projectId, assetId, filename: normalizeVideoUploadFilename(input.filename), principal: { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }, now: Date.now() });
  if (outcome.kind === "not_found") return c.json({ error: "Version not found" }, 404);
  if (outcome.kind === "archived") return archivedResponse(c);
  const videoId = outcome.kind === "set" ? await videoOf(c, projectId, assetId) : outcome.videoId;
  const [video] = videoId === null ? [] : await loadVideoDtos(c.env.DB, projectId, videoId, gate.parts.includes("notes"));
  if (!video) return c.json({ error: "Version not found" }, 404);
  c.header("cache-control", "private, no-store");
  if (outcome.kind === "not_latest_version") return c.json({ error: "A newer version has been uploaded; its file name is changed on that version.", code: "not_latest_version", video }, 409);
  return c.json(videoRenameResponseSchema.parse({ video }));
}));

async function videoOf(c: Ctx, projectId: string, assetId: string): Promise<string | null> {
  return (await c.env.DB.prepare("SELECT m.video_id AS id FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.asset_id = ?1 AND v.project_id = ?2 AND m.removed_at IS NULL AND v.removed_at IS NULL").bind(assetId, projectId).first<{ id: string }>())?.id ?? null;
}
