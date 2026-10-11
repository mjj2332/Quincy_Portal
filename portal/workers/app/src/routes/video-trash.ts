import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  roleHasCapability, videoRemovalImpactSchema, videoRemovalRefusalSchema, videoRemoveInputSchema, videoRemoveResponseSchema, videoRestoreResponseSchema, videoTrashResponseSchema,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { readVideoReviewGate } from "../lib/video-review-gate";
import { loadVideoDtos } from "../lib/video-dto";
import { findTrashedVersion, findTrashedVideo, listTrash, readRemovalImpact, removalRefusal, removeVersion, restoreVersion, restoreVideo, type Principal } from "../lib/video-trash";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Video Trash (#776 C). Every route checks inline, in this order: malformed id 400, the `trash` gate part (closed 404, the same body for a real and an unknown id), `manageVideoTrash` 403 (Admin
 * and Editor only), Project visibility (an External outside the Project 404, staff 403), archived 409 on writes, the row 404, then the body (`.strict()`) and the state. No `.use(...)`:
 * router-wide middleware leaks across sibling mounts (docs/lessons.md). A Project that is archived can still list its Trash and read an impact; it cannot remove or restore.
 */
export const videoTrashRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const archivedResponse = (c: Ctx) => c.json({ error: "Archived projects are read-only; videos can't be removed or restored.", code: "project_archived" }, 409);
const principalOf = (c: Ctx): Principal => { const user = c.get("user"); return { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }; };

/** Gate, capability, access and (for a write) archived. Returns the refusal, or the gate's `notes` part for the Video DTO. */
async function admit(c: Ctx, projectId: string, write: boolean): Promise<Response | { notes: boolean }> {
  const user = c.get("user");
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.parts.includes("trash")) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "manageVideoTrash")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (write && await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  return { notes: gate.parts.includes("notes") };
}

videoTrashRoutes.get("/projects/:projectId/video-trash", terminalRoute("/projects/:projectId/video-trash", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid id" }, 400);
  const admitted = await admit(c, projectId, false); if (admitted instanceof Response) return admitted;
  c.header("cache-control", "private, no-store");
  return c.json(videoTrashResponseSchema.parse(await listTrash(c.env.DB, projectId)));
}));

videoTrashRoutes.get("/projects/:projectId/video-versions/:assetId/removal-impact", terminalRoute("/projects/:projectId/video-versions/:assetId/removal-impact", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const admitted = await admit(c, projectId, false); if (admitted instanceof Response) return admitted;
  const target = await readRemovalImpact(c.env.DB, projectId, assetId, Date.now());
  if (!target) return c.json({ error: "Version not found" }, 404);
  c.header("cache-control", "private, no-store");
  return c.json(videoRemovalImpactSchema.parse(target.impact));
}));

videoTrashRoutes.post("/projects/:projectId/video-versions/:assetId/remove", terminalRoute("/projects/:projectId/video-versions/:assetId/remove", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const admitted = await admit(c, projectId, true); if (admitted instanceof Response) return admitted;
  const now = Date.now();
  const target = await readRemovalImpact(c.env.DB, projectId, assetId, now);
  if (!target) return c.json({ error: "Version not found" }, 404);
  const input = await jsonInput(c, videoRemoveInputSchema); if (input instanceof Response) return input;
  const refuse = (kind: "impact_changed" | "last_version" | "upload_in_progress", impact: typeof target.impact) => {
    switch (kind) {
      case "impact_changed": return c.json(videoRemovalRefusalSchema.parse({ error: "The Version changed since you looked; review what removing it affects.", code: kind, impact }), 409);
      case "last_version": return c.json(videoRemovalRefusalSchema.parse({ error: input.removeVideo ? "This is not the last Version; remove only the Version." : "This is the last Version; removing it removes the Video.", code: kind, impact }), 409);
      case "upload_in_progress": return c.json({ error: "A new Version is being uploaded to this Video; wait for it to finish or cancel it.", code: kind }, 409);
    }
  };
  const early = removalRefusal(target.impact, input); if (early) return refuse(early, target.impact);
  const outcome = await removeVersion(c.env.DB, { projectId, assetId, target, principal: principalOf(c), request: input, now });
  switch (outcome.kind) {
    case "archived": return archivedResponse(c);
    case "not_found": return c.json({ error: "Version not found" }, 404);
    case "impact_changed": case "last_version": case "upload_in_progress": return refuse(outcome.kind, outcome.impact);
    case "removed": break;
  }
  const [video] = input.removeVideo ? [] : await loadVideoDtos(c.env.DB, projectId, target.videoId, admitted.notes);
  return c.json(videoRemoveResponseSchema.parse({ video: video ?? null }));
}));

videoTrashRoutes.post("/projects/:projectId/video-versions/:assetId/restore", terminalRoute("/projects/:projectId/video-versions/:assetId/restore", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const admitted = await admit(c, projectId, true); if (admitted instanceof Response) return admitted;
  const target = await findTrashedVersion(c.env.DB, projectId, assetId);
  if (!target) return c.json({ error: "Version not found in Trash" }, 404);
  const inTrash = () => c.json({ error: "This Version's Video is in Trash; restore the Video first.", code: "video_in_trash" }, 409);
  if (target.videoRemoved) return inTrash();
  const outcome = await restoreVersion(c.env.DB, { projectId, assetId, target, principal: principalOf(c), now: Date.now() });
  if (outcome.kind === "archived") return archivedResponse(c);
  if (outcome.kind === "video_in_trash") return inTrash();
  if (outcome.kind === "not_found") return c.json({ error: "Version not found in Trash" }, 404);
  const [video] = await loadVideoDtos(c.env.DB, projectId, target.videoId, admitted.notes);
  if (!video) return c.json({ error: "Video not found" }, 404);
  return c.json(videoRestoreResponseSchema.parse({ video }));
}));

videoTrashRoutes.post("/projects/:projectId/videos/:videoId/restore", terminalRoute("/projects/:projectId/videos/:videoId/restore", async (c) => {
  const projectId = c.req.param("projectId"); const videoId = c.req.param("videoId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(videoId).success) return c.json({ error: "Invalid id" }, 400);
  const admitted = await admit(c, projectId, true); if (admitted instanceof Response) return admitted;
  const target = await findTrashedVideo(c.env.DB, projectId, videoId);
  if (!target) return c.json({ error: "Video not found in Trash" }, 404);
  const outcome = await restoreVideo(c.env.DB, { projectId, videoId, target, principal: principalOf(c), now: Date.now() });
  if (outcome.kind === "archived") return archivedResponse(c);
  if (outcome.kind !== "restored") return c.json({ error: "Video not found in Trash" }, 404);
  const [video] = await loadVideoDtos(c.env.DB, projectId, videoId, admitted.notes);
  if (!video) return c.json({ error: "Video not found" }, 404);
  return c.json(videoRestoreResponseSchema.parse({ video }));
}));
