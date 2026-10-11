import { z } from "zod";

/**
 * Client Delivery (#787). The gate is a set of `feature_flags` rows read like the video review gate: `client_delivery` (master) plus either `client_delivery_all_projects` or
 * `client_delivery_pilot:<projectId>`. A missing row is off.
 */
export const CLIENT_DELIVERY_MASTER_FLAG = "client_delivery";
export const CLIENT_DELIVERY_ALL_PROJECTS_FLAG = "client_delivery_all_projects";
export const clientDeliveryPilotFlag = (projectId: string): string => `client_delivery_pilot:${projectId}`;

/** The longest payment reference an Unlock may carry, matching the column CHECK on `asset_premium_unlocks`. */
export const ASSET_PAYMENT_REF_MAX = 200;
/** The Asset kinds that can be a paid extra. A Floorplan's state lives on its PDF; its preview resolves to it. */
export const DELIVERY_PREMIUM_KINDS = ["photo", "floorplan_pdf", "copy_pdf"] as const;

export const assetPremiumInputSchema = z.object({ premium: z.boolean() }).strict();
export const assetPremiumUnlockInputSchema = z.object({ unlocked: z.boolean(), paymentRef: z.string().trim().min(1).max(ASSET_PAYMENT_REF_MAX).optional() }).strict();
export const assetPremiumResponseSchema = z.object({ premium: z.boolean(), premiumUnlocked: z.boolean() }).strict();
export type AssetPremiumResponse = z.infer<typeof assetPremiumResponseSchema>;
