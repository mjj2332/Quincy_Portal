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

/** The most Assets one Publish or Preview may carry. D1 binds the selection as one JSON parameter, so this keeps it far inside the statement limits (500 items is about 45 KB). */
export const DELIVERY_SELECTION_MAX = 500;
/** The Publish operation id: a client-chosen idempotency key, 1 to 64 characters, matching the column CHECK on `delivery_sets.operation_id`. */
export const deliveryOperationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** The alphabet of an address suffix: no vowels, no 0, 1, l or o, so a spoken or mistyped suffix cannot spell a word or be confused. */
export const DELIVERY_SLUG_ALPHABET = "23456789bcdfghjkmnpqrstvwxz";
export const DELIVERY_SLUG_SUFFIX_LENGTH = 6;
export const DELIVERY_HANDLE_LENGTH = 16;

const assetIdsSchema = z.array(z.string().uuid()).min(1).max(DELIVERY_SELECTION_MAX).refine((ids) => new Set(ids).size === ids.length, "assetIds must be unique");
/** The selection, in the order the page shows it. The cover must be one of the selected photos. */
export const deliveryPreviewInputSchema = z.object({ assetIds: assetIdsSchema, coverAssetId: z.string().uuid().nullable().optional() }).strict();
export const deliveryPublishInputSchema = z.object({
  assetIds: assetIdsSchema,
  coverAssetId: z.string().uuid().nullable().optional(),
  /** The `latest_set_number` the client saw: `null` before the first Publish. A different value is 409 `stale_set`. */
  expectedLatestSet: z.number().int().min(1).nullable(),
  operationId: deliveryOperationIdSchema,
}).strict();
export const deliveryPageSwitchInputSchema = z.object({ enabled: z.boolean() }).strict();

export const DELIVERY_ITEM_KINDS = ["photo", "floorplan", "copy", "video"] as const;
export type DeliveryItemKind = (typeof DELIVERY_ITEM_KINDS)[number];

/**
 * The page as a viewer sees it, built by one builder for staff Preview, the staff read and (slice 6) the public read. It carries random handles and labels such as "Photo 07", never an
 * Asset id, an R2 key, an original filename, a Video title, or anything about staff, agents, invoices or payment. `url` and `thumbUrl` come from the caller's resolver: behind the staff
 * session for Preview, handle-based for the public page. `locked` is the live lock state, so a locked item is a preview the page must not offer as a download.
 */
export const deliveryItemDtoSchema = z.object({
  handle: z.string().length(DELIVERY_HANDLE_LENGTH),
  kind: z.enum(DELIVERY_ITEM_KINDS),
  label: z.string().min(1).max(40),
  position: z.number().int().nonnegative(),
  locked: z.boolean(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  url: z.string().max(2048).nullable(),
  thumbUrl: z.string().max(2048).nullable(),
}).strict();
export const deliveryPageDtoSchema = z.object({
  property: z.object({ street: z.string(), suburb: z.string().nullable() }).strict(),
  setNumber: z.number().int().min(1),
  /** Epoch milliseconds; null for a Preview, which is not published. */
  publishedAt: z.number().int().nullable(),
  coverHandle: z.string().length(DELIVERY_HANDLE_LENGTH).nullable(),
  items: z.array(deliveryItemDtoSchema),
}).strict();
export type DeliveryItemDto = z.infer<typeof deliveryItemDtoSchema>;
export type DeliveryPageDto = z.infer<typeof deliveryPageDtoSchema>;

/** The staff view of a Project's Delivery page: page state, the latest set with the Asset behind each handle (staff only), and the page as a viewer sees it. */
export const deliveryStateSchema = z.object({
  page: z.object({ slug: z.string(), path: z.string(), enabled: z.boolean(), latestSetNumber: z.number().int().min(1) }).strict().nullable(),
  set: z.object({
    setNumber: z.number().int().min(1),
    publishedAt: z.number().int(),
    coverAssetId: z.string().uuid().nullable(),
    items: z.array(z.object({ assetId: z.string().uuid(), handle: z.string().length(DELIVERY_HANDLE_LENGTH), kind: z.enum(DELIVERY_ITEM_KINDS), label: z.string(), position: z.number().int().nonnegative(), locked: z.boolean() }).strict()),
  }).strict().nullable(),
  dto: deliveryPageDtoSchema.nullable(),
}).strict();
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
