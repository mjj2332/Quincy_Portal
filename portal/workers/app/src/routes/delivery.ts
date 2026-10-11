import { Hono, type Context } from "hono";
import { z } from "zod";
import { deliveryPageSwitchInputSchema, deliveryPreviewInputSchema, deliveryPublishInputSchema, deliveryPublishResponseSchema, deliveryStateSchema, roleHasCapability, type Capability } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { clientDeliveryGate } from "../lib/client-delivery-gate";
import { randomItemHandle } from "../lib/delivery-address";
import { previewDelivery, readDeliveryState } from "../lib/delivery-dto";
import { enqueueDeliveryDerivatives, publishDelivery, setDeliveryPageEnabled } from "../lib/delivery-publish";
import { publishOutboxDetached } from "../lib/server-timing";
import { queueProjectShootDateFollowUps } from "../lib/project-shoot-date";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Client Delivery Publish, Preview, page switch and staff read (#787 slice 5). Every route checks inline, in this order: malformed Project id 400, the Client Delivery gate (closed 404, `{error:"Not
 * found"}`), the route's capability 403, Project visibility (an External outside the Project 404, staff 403), archived 409 `project_archived` (Publish only: Preview, the read and the Admin
 * switch work on an archived Project), the body (`.strict()`), then the state. No `.use(...)`: router-wide middleware leaks across sibling mounts (docs/lessons.md).
 */
export const deliveryRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const archivedResponse = (c: Ctx) => c.json({ error: "Archived projects are read-only; nothing can be published.", code: "project_archived" }, 409);

/** Gate, capability, access and (for Publish) archived. Returns the refusal, or null to carry on. */
export async function admitDelivery(c: Ctx, projectId: string, capability: Capability, refuseArchived: boolean): Promise<Response | null> {
  const user = c.get("user");
  if (!await clientDeliveryGate(c.env.DB, projectId)) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, capability)) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (refuseArchived && await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  return null;
}

deliveryRoutes.get("/projects/:projectId/delivery", terminalRoute("/projects/:projectId/delivery", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admitDelivery(c, projectId, "viewClientPreview", false); if (refused) return refused;
  return c.json(deliveryStateSchema.parse(await readDeliveryState(c.env.DB, projectId)));
}));

deliveryRoutes.post("/projects/:projectId/delivery/preview", terminalRoute("/projects/:projectId/delivery/preview", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admitDelivery(c, projectId, "viewClientPreview", false); if (refused) return refused;
  const input = await jsonInput(c, deliveryPreviewInputSchema); if (input instanceof Response) return input;
  const result = await previewDelivery(c.env.DB, projectId, input.assetIds, input.coverAssetId ?? null, randomItemHandle);
  if (result.ok) return c.json({ dto: result.dto });
  return result.reason === "invalid_cover" ? c.json({ error: "The cover must be one of the selected photos.", code: "invalid_cover" }, 400) : c.json({ error: "Some selected items can't be on a Delivery page.", code: "invalid_selection", assetIds: result.assetIds }, 400);
}));

deliveryRoutes.post("/projects/:projectId/delivery/publish", terminalRoute("/projects/:projectId/delivery/publish", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admitDelivery(c, projectId, "publish", true); if (refused) return refused;
  const input = await jsonInput(c, deliveryPublishInputSchema); if (input instanceof Response) return input;
  const user = c.get("user");
  const outcome = await publishDelivery(c.env, { projectId, principal: { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }, assetIds: input.assetIds, coverAssetId: input.coverAssetId ?? null, expectedLatestSet: input.expectedLatestSet, operationId: input.operationId });
  switch (outcome.kind) {
    case "archived": return archivedResponse(c);
    case "not_found": return c.json({ error: "Project not found" }, 404);
    case "stale_set": return c.json({ error: "The Delivery page changed since you loaded it. Reload and publish again.", code: "stale_set", latestSetNumber: outcome.latestSetNumber }, 409);
    case "delivered_stage_unavailable": return c.json({ error: "This Project can't be moved to Delivered right now, so it can't be published. Nothing was changed.", code: "delivered_stage_unavailable" }, 409);
    case "invalid_cover": return c.json({ error: "The cover must be one of the selected photos.", code: "invalid_cover" }, 400);
    case "invalid_selection": return c.json({ error: "Some selected items can't be on a Delivery page.", code: "invalid_selection", assetIds: outcome.assetIds }, 400);
    // A replay returns the CURRENT state: an older set's handle URLs are no longer served, so its DTO would be unusable. `operationSetNumber` says which set the retried operation landed as.
    case "replayed": return c.json(deliveryPublishResponseSchema.parse({ replayed: true, operationSetNumber: outcome.setNumber, ...await readDeliveryState(c.env.DB, projectId) }));
    case "published": {
      // After the commit, none of it able to fail the response: the Stage move's outbox publication and Shoot date follow-ups, then the slice-4 derivative hook.
      if (outcome.publicationIds.length) c.executionCtx.waitUntil(publishOutboxDetached(c.env.NOTIFICATION_QUEUE, c.env.DB, outcome.publicationIds));
      if (outcome.shootDateFilled) c.executionCtx.waitUntil(queueProjectShootDateFollowUps(c.env, projectId));
      c.executionCtx.waitUntil(enqueueDeliveryDerivatives(c.env, { projectId, setNumber: outcome.setNumber, assetIds: outcome.assetIds }).catch((error) => console.error("Delivery derivative enqueue failed", { projectId, error })));
      return c.json(deliveryPublishResponseSchema.parse({ replayed: false, operationSetNumber: outcome.setNumber, ...await readDeliveryState(c.env.DB, projectId, { setNumber: outcome.setNumber }) }), 201);
    }
  }
}));

deliveryRoutes.put("/projects/:projectId/delivery/page", terminalRoute("/projects/:projectId/delivery/page", async (c) => {
  const projectId = c.req.param("projectId");
  if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admitDelivery(c, projectId, "switchDeliveryPage", false); if (refused) return refused;
  const input = await jsonInput(c, deliveryPageSwitchInputSchema); if (input instanceof Response) return input;
  const user = c.get("user");
  const result = await setDeliveryPageEnabled(c.env.DB, { projectId, principal: { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }, enabled: input.enabled });
  if (result === "no_page") return c.json({ error: "This Project has no Delivery page yet; it is created by the first Publish.", code: "no_page" }, 404);
  return c.json(deliveryStateSchema.parse(await readDeliveryState(c.env.DB, projectId)));
}));
