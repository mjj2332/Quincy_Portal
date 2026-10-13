import { Hono, type Context } from "hono";
import { z } from "zod";
import { reviewStatusTransitions, videoReviewStatusInputSchema, videoReviewStatusResponseSchema } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { readVideoReviewGate } from "../lib/video-review-gate";
import { loadVideoDtos } from "../lib/video-dto";
import { setVersionReviewStatus } from "../lib/video-review-status";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Review status of a Video Version (#863). Checked inline, in this order: malformed id 400, the video review gate (closed 404, no part of its own), the strict body 400, the capability for the
 * TARGET status 403 (`approveVideoInternal` for Approved (internal), `annotateVideo` for In review), Project visibility (an External outside the Project 404, staff 403), archived (staff 409, an
 * External 404 as notes do), the Version 404, then the state: a Version that is no longer the latest 409 `not_latest_version`, a stale `expectedStatus` 409 `review_status_conflict`, each with
 * the fresh Video. The path names the Version the pill was read on, so an upload that landed in between can never carry an approval onto the new cut. No `.use(...)`: router-wide middleware
 * leaks across sibling mounts (docs/lessons.md). Published is derived on read and is not a value of this route.
 */
export const videoReviewStatusRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const archivedResponse = (c: Ctx) => c.get("user").role === "external_editor"
  ? c.json({ error: "Project not found" }, 404)
  : c.json({ error: "Archived projects are read-only; the review status can't be changed.", code: "project_archived" }, 409);

videoReviewStatusRoutes.put("/projects/:projectId/video-versions/:assetId/review-status", terminalRoute("/projects/:projectId/video-versions/:assetId/review-status", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId"); const user = c.get("user");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.open) return c.json({ error: "Not found" }, 404);
  const input = await jsonInput(c, videoReviewStatusInputSchema); if (input instanceof Response) return input;
  if (!reviewStatusTransitions(user.role).includes(input.reviewStatus)) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  const outcome = await setVersionReviewStatus(c.env.DB, { projectId, assetId, status: input.reviewStatus, expected: input.expectedStatus, principal: { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }, now: Date.now() });
  if (outcome.kind === "not_found") return c.json({ error: "Version not found" }, 404);
  if (outcome.kind === "archived") return archivedResponse(c);
  const videoId = outcome.kind === "set" ? await videoOf(c, projectId, assetId) : outcome.videoId;
  const [video] = videoId === null ? [] : await loadVideoDtos(c.env.DB, projectId, videoId, gate.parts.includes("notes"));
  if (!video) return c.json({ error: "Version not found" }, 404);
  c.header("cache-control", "private, no-store");
  if (outcome.kind === "not_latest_version") return c.json({ error: "A newer Version has been uploaded; its review status is set on that Version.", code: "not_latest_version", video }, 409);
  if (outcome.kind === "conflict") return c.json({ error: "The review status changed since you looked.", code: "review_status_conflict", video }, 409);
  return c.json(videoReviewStatusResponseSchema.parse({ video }));
}));

async function videoOf(c: Ctx, projectId: string, assetId: string): Promise<string | null> {
  return (await c.env.DB.prepare("SELECT m.video_id AS id FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.asset_id = ?1 AND v.project_id = ?2 AND m.removed_at IS NULL AND v.removed_at IS NULL").bind(assetId, projectId).first<{ id: string }>())?.id ?? null;
}
