import { Hono } from "hono";
import { reviewStatusTransitions, videoReviewStatusInputSchema, videoReviewStatusResponseSchema } from "@quincy/shared";
import type { AppEnv } from "../env";
import { terminalRoute } from "../lib/terminal-route";
import { setVersionReviewStatus } from "../lib/video-review-status";
import { jsonInput, principalOf } from "./helpers";
import { admitVersionWrite, answerVersionWrite, openVersionWrite } from "./video-version-write";

/**
 * Review status of a Video Version (#863). Checked inline, in this order: malformed id 400, the video review gate (closed 404, no part of its own), the strict body 400, the capability for the
 * TARGET status 403 (`approveVideoInternal` for Approved (internal), `annotateVideo` for In review), Project visibility (an External outside the Project 404, staff 403), archived (staff 409, an
 * External 404 as notes do), the Version 404, then the state: a Version that is no longer the latest 409 `not_latest_version`, a stale `expectedStatus` 409 `review_status_conflict`, each with
 * the fresh Video. The path names the Version the pill was read on, so an upload that landed in between can never carry an approval onto the new cut. No `.use(...)`: router-wide middleware
 * leaks across sibling mounts (docs/lessons.md). Published is derived on read and is not a value of this route.
 */
export const videoReviewStatusRoutes = new Hono<AppEnv>();

videoReviewStatusRoutes.put("/projects/:projectId/video-versions/:assetId/review-status", terminalRoute("/projects/:projectId/video-versions/:assetId/review-status", async (c) => {
  const target = await openVersionWrite(c); if (target instanceof Response) return target;
  const input = await jsonInput(c, videoReviewStatusInputSchema); if (input instanceof Response) return input;
  if (!reviewStatusTransitions(c.get("user").role).includes(input.reviewStatus)) return c.json({ error: "Forbidden" }, 403);
  const refused = await admitVersionWrite(c, target.projectId, "review status"); if (refused) return refused;
  const outcome = await setVersionReviewStatus(c.env.DB, { projectId: target.projectId, assetId: target.assetId, status: input.reviewStatus, expected: input.expectedStatus, principal: principalOf(c), now: Date.now() });
  return answerVersionWrite(c, target, outcome, {
    noun: "review status", schema: videoReviewStatusResponseSchema,
    conflicts: {
      not_latest_version: { code: "not_latest_version", error: "A newer Version has been uploaded; its review status is set on that Version." },
      conflict: { code: "review_status_conflict", error: "The review status changed since you looked." },
    },
  });
}));
