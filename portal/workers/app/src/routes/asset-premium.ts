import { Hono, type Context } from "hono";
import { z } from "zod";
import { assetPremiumInputSchema, assetPremiumResponseSchema, assetPremiumUnlockInputSchema, roleHasCapability } from "@quincy/shared";
import type { AppEnv } from "../env";
import { hasProjectAccess } from "../middleware/capability";
import { projectIsArchived } from "../lib/project-archive";
import { terminalRoute } from "../lib/terminal-route";
import { clientDeliveryGate } from "../lib/client-delivery-gate";
import { findPremiumAsset, isPremiumEligible, setAssetPremium, setAssetUnlock, type Principal } from "../lib/asset-premium";
import { jsonInput } from "./helpers";

const uuid = z.string().uuid();

/**
 * Photo and document premium and Unlock (#787 slice 2). Every route checks inline, in this order: malformed id 400, the Client Delivery gate (closed 404, the same body for a real and an
 * unknown id), `manageExtras` 403 (Admin and Editor), Project visibility (an External outside the Project 404, staff 403), archived 409 `project_archived`, the Asset 404 (not of this
 * Project, or not the current copy), the body (`.strict()`), then the state (409 `not_premium_eligible` for a Video Version or a Floorplan preview). No `.use(...)`: router-wide
 * middleware leaks across sibling mounts (docs/lessons.md). Video premium keeps its own routes in `video-approval.ts`.
 */
export const assetPremiumRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
const archivedResponse = (c: Ctx) => c.json({ error: "Archived projects are read-only; premium can't be changed.", code: "project_archived" }, 409);
const notEligible = (c: Ctx) => c.json({ error: "Only a photo, a Floorplan PDF or a Copy document can be a paid extra.", code: "not_premium_eligible" }, 409);
const assetNotFound = (c: Ctx) => c.json({ error: "Asset not found" }, 404);
const principalOf = (c: Ctx): Principal => { const user = c.get("user"); return { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }; };

/** Gate, capability, access and archived. Returns the refusal, or null to carry on. */
async function admit(c: Ctx, projectId: string): Promise<Response | null> {
  const user = c.get("user");
  if (!await clientDeliveryGate(c.env.DB, projectId)) return c.json({ error: "Not found" }, 404);
  if (!roleHasCapability(user.role, "manageExtras")) return c.json({ error: "Forbidden" }, 403);
  if (!await hasProjectAccess(c, projectId)) return user.role === "external_editor" ? c.json({ error: "Project not found" }, 404) : c.json({ error: "Forbidden: you are not assigned to this project" }, 403);
  if (await projectIsArchived(c.env, projectId)) return archivedResponse(c);
  return null;
}

assetPremiumRoutes.put("/projects/:projectId/assets/:assetId/delivery-premium", terminalRoute("/projects/:projectId/assets/:assetId/delivery-premium", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId); if (refused) return refused;
  const asset = await findPremiumAsset(c.env.DB, projectId, assetId); if (!asset) return assetNotFound(c);
  const input = await jsonInput(c, assetPremiumInputSchema); if (input instanceof Response) return input;
  if (!isPremiumEligible(asset.kind)) return notEligible(c);
  const result = await setAssetPremium(c.env.DB, { projectId, assetId, principal: principalOf(c), premium: input.premium, now: Date.now() });
  if (result === "archived") return archivedResponse(c);
  return result === "not_found" ? assetNotFound(c) : c.json(assetPremiumResponseSchema.parse(result));
}));

assetPremiumRoutes.put("/projects/:projectId/assets/:assetId/delivery-premium-unlock", terminalRoute("/projects/:projectId/assets/:assetId/delivery-premium-unlock", async (c) => {
  const projectId = c.req.param("projectId"); const assetId = c.req.param("assetId");
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
  const refused = await admit(c, projectId); if (refused) return refused;
  const asset = await findPremiumAsset(c.env.DB, projectId, assetId); if (!asset) return assetNotFound(c);
  const input = await jsonInput(c, assetPremiumUnlockInputSchema); if (input instanceof Response) return input;
  if (!isPremiumEligible(asset.kind)) return notEligible(c);
  const result = await setAssetUnlock(c.env.DB, { projectId, assetId, principal: principalOf(c), unlocked: input.unlocked, paymentRef: input.unlocked ? input.paymentRef ?? null : null, now: Date.now() });
  if (result === "archived") return archivedResponse(c);
  return result === "not_found" ? assetNotFound(c) : c.json(assetPremiumResponseSchema.parse(result));
}));
