import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  roleHasCapability, videoDecisionInputSchema, videoDecisionRecordedResponseSchema, videoDecisionsResponseSchema, videoPremiumInputSchema, videoPremiumResponseSchema, videoPremiumUnlockInputSchema,
  videoReleaseInputSchema, videoReleaseResponseSchema, videoReleaseWithdrawnResponseSchema, type Capability,
} from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { readVideoReviewGate } from "../lib/video-review-gate";
import { findVersion, findVideo, loadDecisions, recordStaffDecision, releaseVerdict, releaseVersion, setPremium, setPremiumUnlock, withdrawRelease, type Principal } from "../lib/video-approval";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Staff approval, Release and premium (#741 14a). Every route checks inline, in this order: malformed id 400, the `delivery` gate part (closed 404, the same body for a real and an
 * unknown id), the route's capability 403 (`shareVideo` to read decisions, `releaseVideo` to record, release and withdraw, `manageVideoPremium` for the two premium setters), Project
 * visibility (an External outside the Project 404, staff 403), archived 409 on writes, the Version or Video 404, then the body and the state. No `.use(...)`: router-wide middleware
 * leaks across sibling mounts (docs/lessons.md).
 */
export const videoApprovalRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const archivedResponse = (c: Ctx) => c.json({ error: "Archived projects are read-only; approvals, Releases and premium can't be changed.", code: "project_archived" }, 409);
const versionNotFound = (c: Ctx) => c.json({ error: "Version not found" }, 404);
const videoNotFound = (c: Ctx) => c.json({ error: "Video not found" }, 404);
const principalOf = (c: Ctx): Principal => { const user = c.get("user"); return { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }; };

/** Gate, capability, access and (for a write) archived. Returns the refusal, or null to carry on. */
async function admit(c: Ctx, projectId: string, capability: Capability, write: boolean): Promise<Response | null> {
  const user = c.get("user");
  const gate = await readVideoReviewGate(c.env.DB, projectId);
  if (!gate.parts.includes("delivery")) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, capability)) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (write && await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  return null;
}

videoApprovalRoutes.get("/projects/:projectId/videos/:videoId/decisions", terminalRoute("/projects/:projectId/videos/:videoId/decisions", async (c) => {
  const projectId = c.req.param("projectId"); const videoId = c.req.param("videoId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(videoId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, "shareVideo", false); if (refused) return refused;
  if (!await findVideo(c.env.DB, projectId, videoId)) return videoNotFound(c);
  return c.json(videoDecisionsResponseSchema.parse({ versions: await loadDecisions(c.env.DB, projectId, videoId) }));
}));

videoApprovalRoutes.post("/projects/:projectId/video-versions/:assetId/decisions", terminalRoute("/projects/:projectId/video-versions/:assetId/decisions", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, "releaseVideo", true); if (refused) return refused;
  if (!await findVersion(c.env.DB, projectId, assetId)) return versionNotFound(c);
  const input = await jsonInput(c, videoDecisionInputSchema); if (input instanceof Response) return input;
  const event = await recordStaffDecision(c.env.DB, { projectId, assetId, principal: principalOf(c), decision: input.decision, note: input.note || null, now: Date.now() });
  if (!event) {
    if (await projectIsArchived(c.env, projectId)) return archivedResponse(c);
    if (!await findVersion(c.env.DB, projectId, assetId)) return versionNotFound(c);
    return c.json({ error: "Another decision landed at the same time; try again.", code: "decision_conflict" }, 409);
  }
  return c.json(videoDecisionRecordedResponseSchema.parse({ decision: event }), 201);
}));

videoApprovalRoutes.post("/projects/:projectId/video-versions/:assetId/release", terminalRoute("/projects/:projectId/video-versions/:assetId/release", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, "releaseVideo", true); if (refused) return refused;
  if (!await findVersion(c.env.DB, projectId, assetId)) return versionNotFound(c);
  const input = await jsonInput(c, videoReleaseInputSchema); if (input instanceof Response) return input;
  const answer = (verdict: Awaited<ReturnType<typeof releaseVerdict>>) => {
    switch (verdict.kind) {
      case "already_released": return c.json({ error: "This Version is already released.", code: "already_released" }, 409);
      case "not_approved": return c.json({ error: "That revision is not an approval.", code: "not_approved" }, 422);
      case "stale": return c.json({ error: "The client decision changed; review it before releasing.", code: "release_stale", current: verdict.current }, 409);
      case "ok": return null;
    }
  };
  const early = answer(await releaseVerdict(c.env.DB, assetId, input.approvalRevision)); if (early) return early;
  const result = await releaseVersion(c.env.DB, { projectId, assetId, principal: principalOf(c), approvalRevision: input.approvalRevision, now: Date.now() });
  if ("release" in result) return c.json(videoReleaseResponseSchema.parse({ release: result.release }), 201);
  if (result.kind === "archived") return archivedResponse(c);
  if (!await findVersion(c.env.DB, projectId, assetId)) return versionNotFound(c);
  return answer(result) ?? c.json({ error: "The client decision changed; review it before releasing.", code: "release_stale", current: null }, 409);
}));

videoApprovalRoutes.delete("/projects/:projectId/video-versions/:assetId/release", terminalRoute("/projects/:projectId/video-versions/:assetId/release", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, "releaseVideo", true); if (refused) return refused;
  if (!await findVersion(c.env.DB, projectId, assetId)) return versionNotFound(c);
  const outcome = await withdrawRelease(c.env.DB, { projectId, assetId, principal: principalOf(c), now: Date.now() });
  if (outcome === "archived") return archivedResponse(c);
  if (outcome === "none") return c.json({ error: "This Version has no live Release.", code: "no_live_release" }, 404);
  return c.json(videoReleaseWithdrawnResponseSchema.parse({ released: false }));
}));

videoApprovalRoutes.put("/projects/:projectId/videos/:videoId/premium", terminalRoute("/projects/:projectId/videos/:videoId/premium", async (c) => {
  const projectId = c.req.param("projectId"); const videoId = c.req.param("videoId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(videoId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, "manageVideoPremium", true); if (refused) return refused;
  if (!await findVideo(c.env.DB, projectId, videoId)) return videoNotFound(c);
  const input = await jsonInput(c, videoPremiumInputSchema); if (input instanceof Response) return input;
  const result = await setPremium(c.env.DB, { projectId, videoId, principal: principalOf(c), premium: input.premium, now: Date.now() });
  if (result === "archived") return archivedResponse(c);
  return result === "not_found" ? videoNotFound(c) : c.json(videoPremiumResponseSchema.parse(result));
}));

videoApprovalRoutes.put("/projects/:projectId/videos/:videoId/premium-unlock", terminalRoute("/projects/:projectId/videos/:videoId/premium-unlock", async (c) => {
  const projectId = c.req.param("projectId"); const videoId = c.req.param("videoId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(videoId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId, "manageVideoPremium", true); if (refused) return refused;
  if (!await findVideo(c.env.DB, projectId, videoId)) return videoNotFound(c);
  const input = await jsonInput(c, videoPremiumUnlockInputSchema); if (input instanceof Response) return input;
  const result = await setPremiumUnlock(c.env.DB, { projectId, videoId, principal: principalOf(c), unlocked: input.unlocked, paymentRef: input.unlocked ? input.paymentRef ?? null : null, now: Date.now() });
  if (result === "archived") return archivedResponse(c);
  return result === "not_found" ? videoNotFound(c) : c.json(videoPremiumResponseSchema.parse(result));
}));
