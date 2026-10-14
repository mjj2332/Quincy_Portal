import { Hono } from "hono";
import { normalizeVideoUploadFilename, roleHasCapability, videoRenameInputSchema, videoRenameResponseSchema } from "@quincy/shared";
import type { AppEnv } from "../env";
import { terminalRoute } from "../lib/terminal-route";
import { renameVersion } from "../lib/video-rename";
import { jsonInput, principalOf } from "./helpers";
import { admitVersionWrite, answerVersionWrite, openVersionWrite } from "./video-version-write";

/**
 * Rename a Video (#867). Checked inline, in this order: malformed id 400, the video review gate (closed 404, no part of its own), the `uploadVideo` capability 403 (whoever can upload can already
 * retitle by uploading), Project visibility (an External outside the Project 404, staff 403), archived (staff 409, an External 404), the strict body 400, the Version 404, then a Version that is
 * no longer the latest 409 `not_latest_version` with the fresh Video. The path names the Version the dialog was opened on, so an upload that landed in between is never renamed by mistake. A `.mov`
 * is stored as `.mp4` as upload does. No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md).
 */
export const videoRenameRoutes = new Hono<AppEnv>();

videoRenameRoutes.put("/projects/:projectId/video-versions/:assetId/file-name", terminalRoute("/projects/:projectId/video-versions/:assetId/file-name", async (c) => {
  const target = await openVersionWrite(c); if (target instanceof Response) return target;
  const user = c.get("user");
  if (!roleHasCapability(user.role, "uploadVideo")) return c.json({ error: "Forbidden", capability: "uploadVideo" }, 403);
  const refused = await admitVersionWrite(c, target.projectId, "file name"); if (refused) return refused;
  const input = await jsonInput(c, videoRenameInputSchema); if (input instanceof Response) return input;
  const outcome = await renameVersion(c.env.DB, { projectId: target.projectId, assetId: target.assetId, filename: normalizeVideoUploadFilename(input.filename), principal: principalOf(c), now: Date.now() });
  return answerVersionWrite(c, target, outcome, { noun: "file name", schema: videoRenameResponseSchema, conflicts: { not_latest_version: { code: "not_latest_version", error: "A newer version has been uploaded; its file name is changed on that version." } } });
}));
